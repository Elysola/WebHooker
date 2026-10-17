import type { Config, WebhookEvent, Env, Route, Group, NeutralMessage } from "../types";
import { formatEvent } from "../formatters";
import { emojiPrefix, forgeInfo } from "../formatters/helpers";
import { matchRoute, eventOwners } from "../events/match";
import { log } from "../lib/log";
import { loadTranslations, t as translate, type Translations } from "../lib/i18n";
import type { SendRecord } from "../lib/send-log";
import { recordSendBatch } from "../lib/send-log-batch";
import { explainRoute } from "../config/schema";
import { messageTracker } from "../lib/message-tracker";
import {
  loadGroups,
  groupAcceptsOwners,
  groupAcceptsProvider,
  groupAcceptsInstallation,
} from "../web/groups";
import { getDriver } from "../drivers";
import type { SendResult } from "../drivers/types";
import type { DispatchFailure, DispatchSummary } from "../queue/delivery";
import { getCheckSuiteBuildLogUrl } from "../github/check-run";
import { getWorkflowRunJobs } from "../github/workflow-jobs";

/** One dispatch attempt (route × target), collected for the group webhook log. */
interface DispatchAttempt {
  groupId?: string;
  routeId: string;
  routeName: string;
  target: string;
  ok: boolean;
  error?: string;
  errorCode?: string;
  status?: number;
}

export async function dispatchEvent(
  config: Config,
  event: WebhookEvent,
  env: Env,
  groups?: Group[],
): Promise<DispatchSummary> {
  const loadedGroups = groups ?? (await loadGroups(env.KV));
  const groupById = new Map(loadedGroups.map((g) => [g.id, g]));
  const tracker = messageTracker(env.DB, env.KV);

  // Message language is configured per group (Group.lang), not per route.
  const langs = [...new Set(loadedGroups.map((g) => g.lang ?? "en"))];
  const trMap = new Map<string, Translations>();
  await Promise.all(
    langs.map(async (lang) => {
      trMap.set(lang, await loadTranslations(lang, env.KV));
    }),
  );

  const owners = eventOwners(event);

  const accepted = (route: Route): boolean => {
    if (!route.groupId) return true;
    const group = groupById.get(route.groupId);
    if (!group) return true;
    if (!groupAcceptsInstallation(group, event.installationId)) return false;
    if (!groupAcceptsOwners(group, owners)) return false;
    return groupAcceptsProvider(group, event.provider);
  };
  // `stop` and `fallback` act within a route's own group (its routing table), so
  // one group's routes can never silence another group's.
  const scopeOf = (route: Route): string => route.groupId ?? "";
  const regularMatched = new Set(
    config.routes
      .filter((route) => !route.fallback && matchRoute(route, event) && accepted(route))
      .map(scopeOf),
  );
  const stopped = new Set<string>();

  const attempts: DispatchAttempt[] = [];
  const sendLogs: SendRecord[] = [];

  let workflowJobsPromise: Promise<void> | undefined;
  function ensureWorkflowJobs(): Promise<void> {
    if (event.event !== "workflow_run") return Promise.resolve();
    workflowJobsPromise ??= (async (): Promise<void> => {
      const run = event.payload.workflow_run as { jobs_url?: string; jobs?: unknown[] } | undefined;
      if (!run?.jobs_url || run.jobs?.length) return;
      const jobs = await getWorkflowRunJobs(
        run.jobs_url,
        env.GITHUB_APP_ID,
        env.GITHUB_PRIVATE_KEY,
        event.installationId,
      );
      if (jobs) run.jobs = jobs;
    })();
    return workflowJobsPromise;
  }

  const tasks: Promise<void>[] = [];
  for (const route of config.routes) {
    const scope = scopeOf(route);
    if (stopped.has(scope) || !accepted(route)) continue;
    if (route.fallback) {
      if (!regularMatched.has(scope) && matchRoute(route, event)) {
        tasks.push(processRoute(route));
      }
      continue;
    }
    if (matchRoute(route, event)) {
      tasks.push(processRoute(route));
      if (route.stop) stopped.add(scope);
    }
  }
  await Promise.allSettled(tasks);

  await recordSendBatch(env.DB, sendLogs);
  await sendGroupLogs(attempts);

  const failures: DispatchFailure[] = attempts
    .filter((a) => !a.ok)
    .map((a) => ({
      target: a.target,
      error: a.error,
      errorCode: a.errorCode,
      status: a.status,
    }));
  return { attempts: attempts.length, failures };

  async function sendGroupLogs(list: DispatchAttempt[]): Promise<void> {
    const byGroup = new Map<string, DispatchAttempt[]>();
    for (const a of list) {
      if (!a.groupId) continue;
      const bucket = byGroup.get(a.groupId);
      if (bucket) bucket.push(a);
      else byGroup.set(a.groupId, [a]);
    }
    for (const [groupId, entries] of byGroup) {
      const group = groupById.get(groupId);
      const target = group?.logTarget;
      if (!group || !target) continue;
      const tr = trMap.get(group.lang ?? "en")!;
      try {
        const allOk = entries.every((a) => a.ok);
        const routeLines = entries
          .slice(0, 10)
          .map((a) =>
            a.ok
              ? emojiPrefix("✅", true) +
                translate("log.route_ok", { route: a.routeName, target: a.target }, undefined, tr)
              : emojiPrefix("❌", true) +
                translate(
                  "log.route_fail",
                  { route: a.routeName, target: a.target, error: a.error ?? "?" },
                  undefined,
                  tr,
                ),
          );
        if (entries.length > 10) routeLines.push(`… +${entries.length - 10}`);
        const message: NeutralMessage = {
          title: translate(
            "log.title",
            {
              repo:
                (event.payload.repository as { full_name?: string } | undefined)?.full_name ?? "-",
              event: event.event,
              action: event.payload.action ? `: ${String(event.payload.action)}` : "",
            },
            undefined,
            tr,
          ),
          color: allOk ? 0x3fb950 : 0xf85149,
          fields: [
            {
              name: translate("log.routes", {}, undefined, tr),
              value: routeLines.join("\n"),
              inline: false,
            },
            {
              name: translate("log.delivery", {}, undefined, tr),
              value: event.deliveryId ?? "-",
              inline: true,
            },
          ],
          timestamp: new Date().toISOString(),
        };
        const result = await getDriver(target).send(message, target, env);
        if (!result.ok) {
          log.warn({ groupId, error: result.error }, "Failed to send group webhook log");
        }
      } catch (err) {
        log.error({ groupId, err }, "Group webhook log send failed");
      }
    }
  }

  async function processRoute(route: Route): Promise<void> {
    const targets = route.targets && route.targets.length > 0 ? route.targets : [];
    if (targets.length === 0) return;

    await ensureWorkflowJobs();

    const group = route.groupId ? groupById.get(route.groupId) : undefined;
    const tr = trMap.get(group?.lang ?? "en")!;
    const showEmoji = group?.emoji !== false;
    const message = formatEvent(route, event, tr, showEmoji);
    if (event.event === "check_suite") {
      const suite = event.payload.check_suite as
        | {
            conclusion?: string;
            check_runs_url?: string;
          }
        | undefined;
      if (suite?.conclusion === "failure" && suite.check_runs_url) {
        const buildLogUrl = await getCheckSuiteBuildLogUrl(
          suite.check_runs_url,
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          event.installationId,
        );
        if (buildLogUrl) {
          message.fields = message.fields ?? [];
          message.fields.push({
            name: translate("fields.build_log", {}, undefined, tr),
            value: `[${translate("fields.build_log", {}, undefined, tr)}](${buildLogUrl})`,
            inline: false,
          });
        }
      }
    }
    if (group?.forgeSources?.length) {
      message.forge = forgeInfo(event, group.forgeSources);
    }
    if (route.discordRoleIds?.length) {
      message.mentionRoleIds = route.discordRoleIds;
    }

    const detail: Record<string, unknown> = {
      title: message.title,
      url: message.url,
      description: message.description?.slice(0, 500),
      match: explainRoute(route),
      provider: event.provider,
      installationId: event.installationId,
    };

    for (const target of targets) {
      const targetStr =
        target.platform === "telegram"
          ? target.topicId
            ? `${target.chatId}/${target.topicId}`
            : (target.chatId ?? "")
          : target.platform === "feishu"
            ? (target.chatId ?? "")
            : target.threadId
              ? `${target.channelId}/${target.threadId}`
              : (target.channelId ?? "");

      const base: {
        ts: number;
        routeId: string;
        groupId: string | undefined;
        event: string;
        repo: string | undefined;
        target: string;
        deliveryId: string | undefined;
        actor: string | undefined;
        action: string | undefined;
        detail: Record<string, unknown>;
      } = {
        ts: Date.now(),
        routeId: route.id,
        groupId: route.groupId,
        event: event.event,
        repo: (event.payload.repository as { full_name?: string } | undefined)?.full_name,
        target: targetStr,
        deliveryId: event.deliveryId,
        actor: (event.payload.sender as { login?: string } | undefined)?.login,
        action: event.payload.action as string | undefined,
        detail,
      };

      const started = Date.now();
      try {
        const driver = getDriver(target);
        let result: SendResult;
        if (message.updateKey) {
          const groupPrefix = route.groupId ? `${route.groupId}:` : "";
          const eventId = `${groupPrefix}${route.id}:${message.updateKey}`;
          const kvKey = `msg:${eventId}:${targetStr}`;
          const lockKey = `msg:lock:${kvKey}`;

          // Acquire a short-lived lock so concurrent events for the same
          // updateKey don't race (both read null, both send, the later put
          // overwrites). KV is eventually consistent so the lock is
          // best-effort; a retry loop further shrinks the window.
          let locked = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            const holder = await env.KV.get(lockKey);
            if (holder) {
              const existing = await tracker.get(eventId, targetStr);
              if (existing) {
                result = await driver.edit(message, target, env, existing);
                if (result.ok || /not modified/i.test(result.error ?? "")) {
                  const ok = result.ok || /not modified/i.test(result.error ?? "");
                  attempts.push({
                    groupId: route.groupId,
                    routeId: route.id,
                    routeName: route.name,
                    target: targetStr,
                    ok: true,
                  });
                  sendLogs.push({
                    ...base,
                    ok: true,
                    status: result.status,
                    messageId: existing,
                    platform: driver.id,
                    attempts: result.attempts,
                    durationMs: Date.now() - started,
                    errorCode: result.errorCode,
                  });
                  if (!ok) await tracker.delete(eventId, targetStr);
                  continue;
                }
                await tracker.delete(eventId, targetStr);
                break;
              }
              await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
              continue;
            }
            await env.KV.put(lockKey, "1", { expirationTtl: 60 });
            locked = true;
            break;
          }

          try {
            const existingId = await tracker.get(eventId, targetStr);
            if (existingId) {
              result = await driver.edit(message, target, env, existingId);
              if (result.ok) {
                attempts.push({
                  groupId: route.groupId,
                  routeId: route.id,
                  routeName: route.name,
                  target: targetStr,
                  ok: true,
                });
                sendLogs.push({
                  ...base,
                  ok: true,
                  status: result.status,
                  messageId: existingId,
                  platform: driver.id,
                  attempts: result.attempts,
                  durationMs: Date.now() - started,
                  errorCode: result.errorCode,
                });
                continue;
              }
              if (/not modified/i.test(result.error ?? "")) {
                attempts.push({
                  groupId: route.groupId,
                  routeId: route.id,
                  routeName: route.name,
                  target: targetStr,
                  ok: true,
                });
                sendLogs.push({
                  ...base,
                  ok: true,
                  status: result.status,
                  messageId: existingId,
                  platform: driver.id,
                  attempts: result.attempts,
                  durationMs: Date.now() - started,
                  errorCode: result.errorCode,
                });
                continue;
              }
              await tracker.delete(eventId, targetStr);
            }
            result = await driver.send(message, target, env);
            if (result.ok && result.messageId) {
              await tracker.set(eventId, targetStr, result.messageId);
            }
          } finally {
            if (locked) await env.KV.delete(lockKey);
          }
        } else {
          result = await driver.send(message, target, env);
        }
        const durationMs = Date.now() - started;
        if (!result.ok) {
          const error = result.error ?? "Send failed";
          attempts.push({
            groupId: route.groupId,
            routeId: route.id,
            routeName: route.name,
            target: targetStr,
            ok: false,
            error,
            errorCode: result.errorCode,
            status: result.status,
          });
          sendLogs.push({
            ...base,
            ok: false,
            error,
            durationMs,
            status: result.status,
            platform: driver.id,
            attempts: result.attempts,
            errorCode: result.errorCode,
          });
          continue;
        }
        attempts.push({
          groupId: route.groupId,
          routeId: route.id,
          routeName: route.name,
          target: targetStr,
          ok: true,
        });
        sendLogs.push({
          ...base,
          ok: true,
          status: result.status,
          messageId: result.messageId,
          platform: driver.id,
          attempts: result.attempts,
          durationMs,
          errorCode: result.errorCode,
        });
      } catch (err) {
        const durationMs = Date.now() - started;
        const error = err instanceof Error ? err.message : String(err);
        attempts.push({
          groupId: route.groupId,
          routeId: route.id,
          routeName: route.name,
          target: targetStr,
          ok: false,
          error,
        });
        sendLogs.push({
          ...base,
          ok: false,
          error,
          durationMs,
        });
        log.error({ routeId: route.id, target: targetStr, err }, "Route failed");
      }
    }
  }
}
