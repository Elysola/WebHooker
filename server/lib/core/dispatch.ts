import type {
  Config,
  WebhookEvent,
  Env,
  Route,
  RouteTarget,
  Group,
  NeutralMessage,
} from "../types";
import { formatEvent } from "../formatters";
import { emojiPrefix, forgeInfo } from "../formatters/helpers";
import { matchRoute as matchRouteUnsafe, eventOwners } from "../events/match";
import { log } from "../lib/log";
import { loadTranslations, t as translate, type Translations } from "../lib/i18n";
import type { SendRecord } from "../lib/send-log";
import { recordSendBatch } from "../lib/send-log-batch";
import { explainRoute } from "../config/schema";
import { chainLock, messageTracker, type MessageTracker } from "../lib/message-tracker";
import { idempotencyStore, instanceScope, tenantScope } from "../lib/idempotency";
import {
  loadGroups,
  groupAcceptsOwners,
  groupAcceptsProvider,
  groupAcceptsInstallation,
  groupAcceptsGlobalIngress,
} from "../web/groups";
import { destinationOf, getDriver } from "../drivers";
import type { PlatformDriver, SendResult } from "../drivers/types";
import { isRetryableFailure, type DispatchFailure, type DispatchSummary } from "../queue/delivery";
import { getCheckSuiteBuildLogUrl } from "../github/check-run";
import { getWorkflowRunJobs } from "../github/workflow-jobs";

export interface DispatchOptions {
  /**
   * The group whose own webhook ingress (`/webhook/{groupId}`) received the
   * event; undefined for the operator's global endpoint. Tenant events only
   * reach that group, and never use the operator's GitHub App credentials.
   */
  tenantId?: string;
  /**
   * True for a route × target an earlier attempt of the same delivery already
   * finished (sent, or failed for good); it is not attempted again.
   */
  skipTarget?: (targetKey: string) => Promise<boolean>;
  /**
   * Asked before each send; false means this dispatch lost the right to send
   * (its delivery lease was taken over): the target is reported as a
   * transient failure and left to the new holder.
   */
  beforeTarget?: () => Promise<boolean>;
  /**
   * Told right after a target was sent, so the caller can record it at once
   * (should this invocation die mid-dispatch, it is not sent again). Errors
   * are logged and otherwise ignored: the summary still lists the target.
   */
  afterTarget?: (targetKey: string) => Promise<void>;
}

/** One dispatch attempt (route × target), collected for the group webhook log. */
interface DispatchAttempt {
  key: string;
  groupId?: string;
  routeId: string;
  routeName: string;
  target: string;
  ok: boolean;
  error?: string;
  errorCode?: string;
  status?: number;
  /** Finished by an earlier attempt of the delivery (skipped now). */
  earlier?: boolean;
}

/**
 * Match one route, isolating failures: a filter that throws on an unusual
 * payload counts as "no match" for that route only, never stopping the
 * dispatch of every other route and group.
 */
function matchRoute(route: Route, event: WebhookEvent): boolean {
  try {
    return matchRouteUnsafe(route, event);
  } catch (err) {
    log.warn({ routeId: route.id, groupId: route.groupId, err }, "Route filter failed to evaluate");
    return false;
  }
}

/** Human-readable target, also used in send logs. */
function describeTarget(target: RouteTarget): string {
  if (target.platform === "telegram") {
    return target.topicId ? `${target.chatId}/${target.topicId}` : (target.chatId ?? "");
  }
  if (target.platform === "feishu") return target.chatId ?? "";
  return target.threadId ? `${target.channelId}/${target.threadId}` : (target.channelId ?? "");
}

/**
 * Identity of a route × target within a delivery. It names the group by its
 * immutable `instance` (falling back to the id for groups without one), so a
 * retry after any number of renames still recognizes targets already done.
 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function targetKeyOf(group: Group | undefined, route: Route, target: RouteTarget): string {
  const owner = group?.instance ? instanceScope(group.instance) : (route.groupId ?? "");
  return `${owner}:${route.id}:${target.platform ?? "discord"}:${describeTarget(target)}`;
}

/**
 * The forge instance an event came from (provider + repository host), so two
 * sources with the same `owner/repo` never share an update chain.
 */
function eventOrigin(event: WebhookEvent): string {
  const html = (event.payload.repository as { html_url?: string } | undefined)?.html_url;
  let host = "";
  if (html) {
    try {
      host = new URL(html).host.toLowerCase();
    } catch {
      host = "";
    }
  }
  return `${event.provider ?? "github"}@${host || "-"}`;
}

const VERSION_SOURCES = [
  "workflow_run",
  "check_run",
  "check_suite",
  "deployment_status",
  "review",
  "comment",
  "deployment",
] as const;

/** Lifecycle stage of a tracked object: later stages win a tie in event time. */
function stageOf(status: unknown): number {
  // `status` of runs and checks, `state` of deployment statuses.
  if (
    status === "completed" ||
    status === "success" ||
    status === "failure" ||
    status === "error" ||
    status === "inactive"
  ) {
    return 2;
  }
  if (status === "in_progress") return 1;
  return 0;
}

/**
 * Version of the object an update chain tracks — its event time (ms), with
 * its stage (queued < in progress < completed < deleted/dismissed) breaking a
 * tie — so a stale event delivered late never overwrites a newer state, not
 * even one stamped with the same time. Without a time it is the stage alone
 * (below 4, see `outdated`); 0 when nothing is known.
 */
function updateVersion(event: WebhookEvent): number {
  for (const name of VERSION_SOURCES) {
    const obj = event.payload[name] as Record<string, unknown> | undefined;
    if (!obj || typeof obj !== "object") continue;
    // A deletion or dismissal ends the object (its time is that of the last
    // change): nothing stamped the same time may bring it back.
    const action = event.payload.action;
    const stage =
      action === "deleted" || action === "dismissed" ? 3 : stageOf(obj.status ?? obj.state);
    for (const field of [
      "updated_at",
      "completed_at",
      "submitted_at",
      "started_at",
      "created_at",
    ]) {
      const value = obj[field];
      if (typeof value === "string") {
        const ms = Date.parse(value);
        if (Number.isFinite(ms) && ms > 0) return ms * 4 + stage;
      }
    }
    return stage;
  }
  return 0;
}

/**
 * Whether an event at `version` is older than what the chain shows. Without
 * an event time (a version below 4), only the stage decides: an untimed
 * queued event never undoes a completion.
 */
function outdated(stored: number, version: number): boolean {
  if (version >= 4) return stored > version;
  return stored % 4 > version;
}

/**
 * The version a chain keeps once an event at `version` was shown over
 * `stored`: never lower. An untimed event keeps the stored time but moves
 * the stage on (a later untimed queued event must find the completion).
 */
function shownVersion(stored: number, version: number): number {
  if (version >= 4) return Math.max(stored, version);
  return stored - (stored % 4) + Math.max(stored % 4, version);
}

function notModified(result: SendResult): boolean {
  return /not modified/i.test(result.error ?? "");
}

/** The tracked message no longer exists (deleted / not editable): send a new one. */
function messageGone(result: SendResult): boolean {
  if (result.status === 404) return true;
  // Sent by another bot (the deployment switched Discord applications): it
  // can never be edited again — a new message continues the chain.
  if (
    /cannot edit a message authored by another user|"code"\s*:\s*50005\b/i.test(result.error ?? "")
  ) {
    return true;
  }
  return /unknown message|message to edit not found|message can't be edited|no text in the message to edit|message not found|has been (deleted|recalled)/i.test(
    result.error ?? "",
  );
}

const LOCK_ATTEMPTS = 5;
/**
 * Lifetime of an update-chain lock. It must outlast the longest edit + send
 * a holder can make (every platform call is bounded: 3 attempts × 15 s, plus
 * rate-limit waits of ≤ 10 s, plus a Feishu token fetch — under 90 s each),
 * so a slow holder can never land its edit after a newer holder's.
 */
const LOCK_TTL_SECONDS = 240;

/**
 * Send or edit the message of an update chain (workflow progress, edited
 * comments, ...). A best-effort KV lock serializes concurrent events of the
 * same chain; an existing message is edited unless the incoming event is
 * older than what it shows; a new message is sent only when there is none or
 * the old one is gone — never after a transient edit failure, which would
 * leave two messages for one chain.
 */
async function deliverUpdate(
  env: Env,
  tracker: MessageTracker,
  driver: PlatformDriver,
  message: NeutralMessage,
  target: RouteTarget,
  chain: { id: string; target: string; legacyId: string; legacyTarget: string },
  version: number,
): Promise<SendResult> {
  const chainId = chain.id;
  const trackTarget = chain.target;
  const lockKey = `msg:lock:${chainId}:${trackTarget}`;
  const lock = chainLock(env.DB, env.KV);
  let token: string | null = null;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !token; attempt++) {
    token = await lock.acquire(lockKey, LOCK_TTL_SECONDS);
    if (!token) await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
  }
  /**
   * Bookkeeping after the platform call succeeded. A failure here must not
   * turn the delivered message into a failed (and so resent) target: it is
   * logged, and at worst the chain's next update posts a new message.
   */
  const track = async (write: () => Promise<void>): Promise<boolean> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await write();
        return true;
      } catch (err) {
        if (attempt < 3) continue;
        log.warn({ chain: chainId, target: trackTarget, err }, "Failed to track an update message");
        return false;
      }
    }
  };
  if (!token) {
    // Another event of this chain is still being delivered: going ahead could
    // let an older state finish last. Report a transient failure instead (the
    // queue retries it; the version check then skips it if it is outdated).
    return {
      ok: false,
      error: "Another update of this message is in progress",
      errorCode: "RATE_LIMITED",
      attempts: 0,
    };
  }
  try {
    let existing = await tracker.get(chainId, trackTarget);
    // Read first: only an old entry that is there is taken under its lock (a
    // new chain with nothing to adopt costs one read, not a lock taken and
    // released).
    if (!existing && chain.legacyId && (await tracker.get(chain.legacyId, chain.legacyTarget))) {
      // Chains tracked before keys carried the forge origin and platform.
      // Only adopted for github.com, the one forge where `owner/repo` alone is
      // unambiguous; elsewhere the old message could belong to another host.
      // Several new chains may map to one old key (e.g. check runs of two
      // suites): taken under the old key's lock, so exactly one adopts it.
      const legacyLockKey = `msg:lock:legacy:${chain.legacyId}:${chain.legacyTarget}`;
      let legacyToken: string | null = null;
      for (let attempt = 0; attempt < LOCK_ATTEMPTS && !legacyToken; attempt++) {
        legacyToken = await lock.acquire(legacyLockKey, LOCK_TTL_SECONDS);
        if (!legacyToken) await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
      if (!legacyToken) {
        return {
          ok: false,
          error: "Another update of this message is in progress",
          errorCode: "RATE_LIMITED",
          attempts: 0,
        };
      }
      try {
        const legacy = await tracker.get(chain.legacyId, chain.legacyTarget);
        if (legacy) {
          // One transaction: the old entry never survives its adoption (a
          // second chain would take the same message too).
          await tracker.move(
            { eventId: chain.legacyId, targetId: chain.legacyTarget },
            { eventId: chainId, targetId: trackTarget },
            legacy,
          );
          existing = legacy;
        }
      } finally {
        await lock.release(legacyLockKey, legacyToken).catch(() => undefined);
      }
    }
    if (existing) {
      if (outdated(existing.version, version)) {
        // A newer event already updated this message.
        return { ok: true, messageId: existing.messageId, attempts: 0 };
      }
      const result = await driver.edit(message, target, env, existing.messageId);
      if (result.ok || notModified(result)) {
        // Never lower the stored version (another holder may have moved on).
        const tracked = await track(async () => {
          const latest = await tracker.get(chainId, trackTarget);
          await tracker.set(chainId, trackTarget, {
            messageId: existing.messageId,
            version: shownVersion(Math.max(existing.version, latest?.version ?? 0), version),
          });
        });
        // Edited, but the version shown is not on record: a late older event
        // would edit it back. Reported as transient — the retry repeats the
        // (harmless) edit and records the version.
        if (!tracked) {
          return {
            ok: false,
            error: "Edited, but its version could not be recorded",
            messageId: existing.messageId,
            attempts: result.attempts,
          };
        }
        return { ...result, ok: true, messageId: existing.messageId };
      }
      if (!messageGone(result)) return result;
      await tracker.delete(chainId, trackTarget);
    }
    const result = await driver.send(message, target, env);
    if (result.ok && result.messageId) {
      const messageId = result.messageId;
      const tracked = await track(() => tracker.set(chainId, trackTarget, { messageId, version }));
      // Untracked, the chain's next update would post a second message. Where
      // the platform dedupes sends by the message's key (Discord nonce, Feishu
      // uuid), the retry gets this very message back and records it; Telegram
      // cannot, so there the delivery stands (one extra message at worst).
      if (!tracked && message.sendKey && driver.id !== "telegram") {
        return {
          ok: false,
          error: "Sent, but its message id could not be recorded",
          messageId,
          attempts: result.attempts,
        };
      }
    }
    return result;
  } finally {
    // Release only our own lock (it may have expired and been taken over).
    await lock.release(lockKey, token).catch(() => undefined);
  }
}

export async function dispatchEvent(
  config: Config,
  event: WebhookEvent,
  env: Env,
  groups?: Group[],
  options: DispatchOptions = {},
): Promise<DispatchSummary> {
  const { tenantId, skipTarget, beforeTarget, afterTarget } = options;
  const loadedGroups = groups ?? (await loadGroups(env.KV));
  const groupById = new Map(loadedGroups.map((g) => [g.id, g]));
  const tracker = messageTracker(env.DB, env.KV);

  // Message language is configured per group (Group.lang), not per route;
  // loaded when a message is built in it (a group nothing is sent to costs
  // no KV read), once per language.
  const trMap = new Map<string, Promise<Translations>>();
  const trFor = (lang: string): Promise<Translations> => {
    let tr = trMap.get(lang);
    if (!tr) {
      tr = loadTranslations(lang, env.KV);
      trMap.set(lang, tr);
    }
    return tr;
  };

  const owners = eventOwners(event);

  const accepted = (route: Route): boolean => {
    if (tenantId !== undefined) {
      // Per-group ingress: authenticated by that group's own secret, so only
      // its routes are eligible; the installation claim was already dropped.
      if (route.groupId !== tenantId) return false;
      const group = groupById.get(tenantId);
      if (!group) return false;
      return groupAcceptsOwners(group, owners) && groupAcceptsProvider(group, event.provider);
    }
    if (!route.groupId) return true;
    // A route whose group is gone (deleted, or not loaded) has no source
    // restrictions to check, so it must not fire at all.
    const group = groupById.get(route.groupId);
    if (!group) return false;
    if (!groupAcceptsGlobalIngress(group)) return false;
    if (!groupAcceptsInstallation(group, event.installationId)) return false;
    if (!groupAcceptsOwners(group, owners)) return false;
    return groupAcceptsProvider(group, event.provider);
  };
  // `stop` and `fallback` act within a route's own group (its routing table), so
  // one group's routes can never silence another group's. Source checks run
  // before matching: another tenant's filters never see this event.
  const scopeOf = (route: Route): string => route.groupId ?? "";
  // A group with an unreadable route is left out whole: without its full
  // routing table, neither its fallback nor its `stop` can be judged (it is
  // reported as a transient failure below).
  const unreadable = new Set(config.unreadableGroups ?? []);
  const eligible = config.routes.filter((r) => !unreadable.has(r.groupId ?? "") && accepted(r));
  // Each regular route is matched once (filters may run regexes and JSONPath
  // over the payload): the result decides both the group's fallbacks and the
  // dispatch below.
  const matchedRegular = new Set(
    eligible.filter((route) => !route.fallback && matchRoute(route, event)),
  );
  const regularMatched = new Set([...matchedRegular].map(scopeOf));
  const stopped = new Set<string>();

  const attempts: DispatchAttempt[] = [];
  // Targets an earlier attempt finished (skipped now): only for the group
  // summaries, which describe the whole delivery.
  const earlier: DispatchAttempt[] = [];
  const sendLogs: SendRecord[] = [];

  // The operator's GitHub App may only enrich events the operator's own
  // webhook secret vouched for.
  const appId = tenantId === undefined ? env.GITHUB_APP_ID : undefined;
  const privateKey = tenantId === undefined ? env.GITHUB_PRIVATE_KEY : undefined;

  let workflowJobsPromise: Promise<void> | undefined;
  function ensureWorkflowJobs(): Promise<void> {
    if (event.event !== "workflow_run") return Promise.resolve();
    workflowJobsPromise ??= (async (): Promise<void> => {
      const run = event.payload.workflow_run as { jobs_url?: string; jobs?: unknown[] } | undefined;
      if (!run?.jobs_url || run.jobs?.length) return;
      const jobs = await getWorkflowRunJobs(run.jobs_url, appId, privateKey, event.installationId);
      if (jobs) run.jobs = jobs;
    })();
    return workflowJobsPromise;
  }

  // One lookup per dispatch, shared by every route (each would otherwise ask
  // for its own App token and check list — calls that count against the
  // invocation's limit before any message is sent).
  let buildLogPromise: Promise<string | undefined> | undefined;
  function checkSuiteBuildLog(): Promise<string | undefined> {
    buildLogPromise ??= (async (): Promise<string | undefined> => {
      const suite = event.payload.check_suite as
        { conclusion?: string; check_runs_url?: string } | undefined;
      if (event.event !== "check_suite" || suite?.conclusion !== "failure") return undefined;
      if (!suite.check_runs_url) return undefined;
      return getCheckSuiteBuildLogUrl(
        suite.check_runs_url,
        appId,
        privateKey,
        event.installationId,
      );
    })().catch(() => undefined);
    return buildLogPromise;
  }

  const tasks: Promise<void>[] = [];
  for (const route of eligible) {
    const scope = scopeOf(route);
    if (stopped.has(scope)) continue;
    if (route.fallback) {
      if (!regularMatched.has(scope) && matchRoute(route, event)) {
        tasks.push(processRoute(route));
        if (route.stop) stopped.add(scope);
      }
      continue;
    }
    if (matchedRegular.has(route)) {
      tasks.push(processRoute(route));
      if (route.stop) stopped.add(scope);
    }
  }
  // A group with an unreadable route may have had a match we cannot see:
  // report it as a transient failure (retried, and visible in the send log)
  // rather than let the event pass for delivered.
  for (const gid of config.unreadableGroups ?? []) {
    // A group whose own row is unreadable has no source restrictions to
    // check: it fails for every event it could have received.
    if (
      groupById.has(gid)
        ? !accepted({ groupId: gid } as Route)
        : tenantId !== undefined && tenantId !== gid
    ) {
      continue;
    }
    const error =
      "The configuration of this group could not be read; repair it to deliver the event";
    log.error({ groupId: gid, event: event.event }, error);
    attempts.push({
      key: `unreadable:${gid}`,
      groupId: gid,
      routeId: "",
      routeName: "",
      target: "",
      ok: false,
      error,
    });
    sendLogs.push({
      ts: Date.now(),
      routeId: "",
      groupId: gid,
      groupInstance: groupById.get(gid)?.instance,
      event: event.event,
      target: "",
      ok: false,
      error,
      deliveryId: event.deliveryId,
    });
  }
  const settled = await Promise.allSettled(tasks);
  for (const r of settled) {
    if (r.status !== "rejected") continue;
    // Never let a crash pass for success: record it as a transient failure
    // (no error code), so a queued delivery is retried instead of acked.
    log.error({ err: r.reason }, "Route dispatch crashed");
    attempts.push({
      key: "crash",
      routeId: "",
      routeName: "",
      target: "",
      ok: false,
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    });
  }

  await recordSendBatch(env.DB, sendLogs);
  await sendGroupLogs([...attempts, ...earlier]);

  const failures: DispatchFailure[] = attempts
    .filter((a) => !a.ok)
    .map((a) => ({
      key: a.key,
      target: a.target,
      error: a.error,
      errorCode: a.errorCode,
      status: a.status,
    }));
  return {
    attempts: attempts.length,
    failures,
    succeeded: attempts.filter((a) => a.ok).map((a) => a.key),
  };

  async function sendGroupLogs(list: DispatchAttempt[]): Promise<void> {
    const byGroup = new Map<string, DispatchAttempt[]>();
    for (const a of list) {
      if (!a.groupId) continue;
      const bucket = byGroup.get(a.groupId);
      if (bucket) bucket.push(a);
      else byGroup.set(a.groupId, [a]);
    }
    for (const [groupId, unordered] of byGroup) {
      const group = groupById.get(groupId);
      const target = group?.logTarget;
      if (!group || !target) continue;
      // Nothing was attempted for this group now (a redelivery of a finished
      // delivery): its summary was posted when it finished.
      if (unordered.every((a) => a.earlier)) continue;
      let claimed: string | null = null;
      try {
        const tr = await trFor(group.lang ?? "en");
        // In a stable order (targets finish in any order), so the same outcome
        // always reads — and deduplicates — the same.
        const entries = [...unordered].sort((a, b) => {
          const x = `${a.routeId}|${a.key}`;
          const y = `${b.routeId}|${b.key}`;
          return x < y ? -1 : x > y ? 1 : 0;
        });
        // Green only when every target is known to have succeeded: one an
        // earlier attempt finished may have failed for good.
        const allOk = entries.every((a) => a.ok && !a.earlier);
        const anyFailed = entries.some((a) => !a.ok);
        const routeLines = entries
          .slice(0, 10)
          .map((a) =>
            a.earlier
              ? emojiPrefix("⏭️", true) +
                translate(
                  "log.route_earlier",
                  { route: a.routeName, target: a.target },
                  undefined,
                  tr,
                )
              : a.ok
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
          color: allOk ? 0x3fb950 : anyFailed ? 0xf85149 : 0x8b949e,
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
        // A retry of the same delivery that reaches the same outcome posts no
        // second summary (a changed outcome — say, a recovered target — does).
        // Keyed by where each route×target stands — finished (sent, failed
        // for good, or by an earlier attempt) or still to retry — so a retry
        // that skips the finished ones and leaves the rest as they were posts
        // nothing new; not by the truncated, worded lines.
        const outcome = entries
          .map(
            (a) =>
              `${a.routeId}|${a.key}|${a.ok || a.earlier || !isRetryableFailure(a) ? "done" : "retry"}`,
          )
          .join("\n");
        const summaryKey = event.deliveryId
          ? `group-log:${await sha256Hex(
              `${event.provider ?? "github"}|${tenantScope(
                tenantId,
                tenantId ? groupById.get(tenantId)?.instance : undefined,
              )}|${event.deliveryId}|${group.instance ?? groupId}|${outcome}`,
            )}`
          : null;
        if (summaryKey && !(await idempotencyStore(env.DB, env.KV).claim(summaryKey, 86400))) {
          continue;
        }
        claimed = summaryKey;
        const result = await getDriver(target).send(message, target, env);
        if (!result.ok) {
          log.warn({ groupId, error: result.error }, "Failed to send group webhook log");
        } else {
          claimed = null;
        }
      } catch (err) {
        log.error({ groupId, err }, "Group webhook log send failed");
      }
      // Not posted (a failed or thrown send): a retry may try again.
      if (claimed) {
        await idempotencyStore(env.DB, env.KV)
          .release(claimed)
          .catch(() => undefined);
      }
    }
  }

  function baseRecord(
    route: Route,
    targetStr: string,
    detail: Record<string, unknown>,
  ): Omit<SendRecord, "ok"> {
    return {
      ts: Date.now(),
      routeId: route.id,
      groupId: route.groupId,
      groupInstance: route.groupId ? groupById.get(route.groupId)?.instance : undefined,
      event: event.event,
      repo: (event.payload.repository as { full_name?: string } | undefined)?.full_name,
      target: targetStr,
      deliveryId: event.deliveryId,
      actor: (event.payload.sender as { login?: string } | undefined)?.login,
      action: event.payload.action as string | undefined,
      detail,
    };
  }

  function recordFailure(
    route: Route,
    target: RouteTarget,
    detail: Record<string, unknown>,
    failure: { error: string; errorCode?: string; status?: number; platform?: string },
    extra: { durationMs?: number; attempts?: number } = {},
    logged = true,
  ): void {
    const targetStr = describeTarget(target);
    attempts.push({
      key: targetKeyOf(groupById.get(route.groupId ?? ""), route, target),
      groupId: route.groupId,
      routeId: route.id,
      routeName: route.name,
      target: targetStr,
      ok: false,
      error: failure.error,
      errorCode: failure.errorCode,
      status: failure.status,
    });
    if (!logged) return;
    sendLogs.push({
      ...baseRecord(route, targetStr, detail),
      ok: false,
      error: failure.error,
      status: failure.status,
      platform: failure.platform,
      errorCode: failure.errorCode,
      ...extra,
    });
  }

  async function buildRouteMessage(route: Route): Promise<NeutralMessage> {
    await ensureWorkflowJobs();

    const group = route.groupId ? groupById.get(route.groupId) : undefined;
    const tr = await trFor(group?.lang ?? "en");
    const showEmoji = group?.emoji !== false;
    const message = formatEvent(route, event, tr, showEmoji);
    message.emoji = showEmoji;
    if (event.event === "check_suite") {
      const buildLogUrl = await checkSuiteBuildLog();
      if (buildLogUrl) {
        message.fields = message.fields ?? [];
        message.fields.push({
          name: translate("fields.build_log", {}, undefined, tr),
          value: `[${translate("fields.build_log", {}, undefined, tr)}](${buildLogUrl})`,
          inline: false,
        });
      }
    }
    if (group?.forgeSources?.length) {
      message.forge = forgeInfo(event, group.forgeSources);
    }
    if (route.discordRoleIds?.length) {
      message.mentionRoleIds = route.discordRoleIds;
    }
    return message;
  }

  async function processRoute(route: Route): Promise<void> {
    const targets = route.targets && route.targets.length > 0 ? route.targets : [];
    if (targets.length === 0) return;

    const pending: RouteTarget[] = [];
    // A destination listed twice (stored before that was refused) is sent once.
    const seen = new Set<string>();
    for (const target of targets) {
      const key = targetKeyOf(groupById.get(route.groupId ?? ""), route, target);
      const destination = destinationOf(target);
      if (seen.has(destination)) continue;
      seen.add(destination);
      if (skipTarget) {
        let done: boolean;
        try {
          done = await skipTarget(key);
        } catch (err) {
          // Unknown whether it was already sent: retry later rather than
          // resend now or drop it.
          recordFailure(
            route,
            target,
            { match: explainRoute(route) },
            {
              error: `Delivery ledger unavailable: ${err instanceof Error ? err.message : String(err)}`,
            },
          );
          continue;
        }
        if (done) {
          earlier.push({
            key,
            groupId: route.groupId,
            routeId: route.id,
            routeName: route.name,
            target: describeTarget(target),
            ok: true,
            earlier: true,
          });
          continue;
        }
      }
      pending.push(target);
    }
    if (pending.length === 0) return;

    let message: NeutralMessage;
    try {
      message = await buildRouteMessage(route);
    } catch (err) {
      // A payload the formatter cannot handle fails every target of the
      // route explicitly (and permanently) instead of vanishing.
      const error = `Format failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error({ routeId: route.id, event: event.event, err }, "Failed to format event");
      const detail = { match: explainRoute(route), provider: event.provider };
      for (const target of pending) {
        recordFailure(route, target, detail, { error, errorCode: "FORMAT" });
      }
      return;
    }

    const detail: Record<string, unknown> = {
      title: message.title,
      url: message.url,
      description: message.description?.slice(0, 500),
      match: explainRoute(route),
      provider: event.provider,
      installationId: event.installationId,
    };
    const version = message.updateKey ? updateVersion(event) : 0;

    for (const target of pending) {
      const targetStr = describeTarget(target);
      if (beforeTarget && !(await beforeTarget())) {
        // Retried later (a transient failure), but not a send log row: the
        // target was not attempted, and a large fan-out continued over several
        // attempts would log it again each time.
        recordFailure(
          route,
          target,
          detail,
          { error: "Delivery paused before this target (lease lost or out of time); sent later" },
          {},
          false,
        );
        continue;
      }
      const started = Date.now();
      let driver: PlatformDriver | undefined;
      try {
        driver = getDriver(target);
        // The same key in every attempt of this delivery to this target.
        const outgoing: NeutralMessage = event.deliveryId
          ? {
              ...message,
              // Scoped like the delivery itself (global endpoint vs the
              // receiving group's instance): two endpoints' events sharing a
              // delivery id are two messages.
              sendKey: await sha256Hex(
                `${event.provider ?? "github"}|${tenantScope(
                  tenantId,
                  tenantId ? groupById.get(tenantId)?.instance : undefined,
                )}|${event.deliveryId}|${targetKeyOf(
                  groupById.get(route.groupId ?? ""),
                  route,
                  target,
                )}`,
              ),
            }
          : message;
        let result: SendResult;
        if (message.updateKey) {
          const groupPrefix = route.groupId ? `${route.groupId}:` : "";
          // Chains are owned by the group instance: they survive renames, and a
          // group re-created under the id never edits the old group's messages.
          const owner = groupById.get(route.groupId ?? "")?.instance;
          const legacyOwner = groupById.get(route.groupId ?? "")?.legacyId;
          const chainPrefix = owner ? `${instanceScope(owner)}:` : groupPrefix;
          result = await deliverUpdate(
            env,
            tracker,
            driver,
            outgoing,
            target,
            {
              id: `${chainPrefix}${route.id}:${eventOrigin(event)}:${message.updateKey}`,
              target: `${driver.id}:${targetStr}`,
              // Chains from before instances were keyed by the id the group
              // had back then: only that group (its `legacyId`) adopts them,
              // never a group created since under a reused id.
              // (An empty `legacyId` marks the group seeded for routes that
              // had no group: their chains carried no group prefix.)
              legacyId:
                eventOrigin(event) === "github@github.com" && legacyOwner != null
                  ? `${legacyOwner ? `${legacyOwner}:` : ""}${route.id}:${
                      message.legacyUpdateKey ?? message.updateKey
                    }`
                  : "",
              legacyTarget: targetStr,
            },
            version,
          );
        } else {
          result = await driver.send(outgoing, target, env);
        }
        const durationMs = Date.now() - started;
        if (!result.ok) {
          recordFailure(
            route,
            target,
            detail,
            {
              error: result.error ?? "Send failed",
              errorCode: result.errorCode,
              status: result.status,
              platform: driver.id,
            },
            { durationMs, attempts: result.attempts },
          );
          continue;
        }
        const key = targetKeyOf(groupById.get(route.groupId ?? ""), route, target);
        if (afterTarget) {
          await afterTarget(key).catch((err: unknown) => {
            log.warn({ routeId: route.id, target: targetStr, err }, "Failed to record sent target");
          });
        }
        attempts.push({
          key,
          groupId: route.groupId,
          routeId: route.id,
          routeName: route.name,
          target: targetStr,
          ok: true,
        });
        sendLogs.push({
          ...baseRecord(route, targetStr, detail),
          ok: true,
          status: result.status,
          messageId: result.messageId,
          platform: driver.id,
          attempts: result.attempts,
          durationMs,
          errorCode: result.errorCode,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        recordFailure(
          route,
          target,
          detail,
          { error, platform: driver?.id },
          { durationMs: Date.now() - started },
        );
        log.error({ routeId: route.id, target: targetStr, err }, "Route failed");
      }
    }
  }
}
