import type { H3Event } from "h3";
import { getHeader, readRawBody, setResponseStatus } from "h3";
import type { Env, Group } from "./types";
import { detectProvider } from "./providers";
import { dispatchEvent } from "./core/dispatch";
import { loadConfigSnapshot, loadGroupFresh, initConfigStore } from "./config";
import { ensureInstallationGroup } from "./web/groups";
import { getTenantSecret } from "./web/tenants";
import { NONCE_TTL_SECONDS, ReplayPendingError, replayNonceKey } from "./providers/custom";
import { recordAudit } from "./lib/audit";
import { cfEnv, cfWaitUntil, headersFrom } from "./cf";
import { log } from "./lib/log";
import { claimOnce, confirmClaim, deliveryKey, idempotencyStore } from "./lib/idempotency";
import { newCorrelationId } from "./lib/correlation";
import {
  deliveryStateKey,
  enqueueWebhook,
  hadPermanentFailure,
  isRetryableFailure,
  markTargetsDone,
  targetDoneChecker,
  type DeliveryMessage,
} from "./queue/delivery";

const MAX_BODY_SIZE = 1024 * 1024;
/** How long a delivery's dedup claim lasts when it is queued. */
const QUEUED_CLAIM_SECONDS = 120;
/** How long it lasts for an inline dispatch, which may run for minutes. */
const INLINE_CLAIM_SECONDS = 600;
/** An installation's auto-provisioning is remembered as long as delivery state (7 days). */
const PROVISIONED_TTL_SECONDS = 7 * 86400;
/** Sending time of one inline dispatch: within its claim, with a margin. */
const INLINE_SEND_BUDGET_MS = 8 * 60_000;

/** Result of an inline dispatch: whether the sender should retry. */
interface InlineOutcome {
  retry: boolean;
  /** A target failed for good (in this or an earlier attempt). */
  failed: boolean;
}

export interface WebhookResult {
  status: 200 | 400 | 401 | 404 | 413 | 503;
  body: unknown;
}

/**
 * Core webhook processing. Without `tenantId` this is the legacy global
 * endpoint (`POST /webhook`): events verify against the operator's global
 * secrets and may dispatch into every route. With a `tenantId` (a group id,
 * `POST /webhook/{groupId}`) the group's own secret is used for verification
 * (GITHUB_WEBHOOK_SECRET/GITEA_WEBHOOK_SECRET are overridden per request) and
 * only that group's routes are eligible.
 *
 * A tenant-signed payload is only as trustworthy as the tenant: its claimed
 * GitHub App installation is dropped, so it can neither borrow the operator's
 * App credentials nor provision or rebind installation groups.
 */
export async function processWebhook(
  env: Env,
  body: string,
  headers: Record<string, string>,
  waitUntil: (promise: Promise<unknown>) => void,
  tenantId?: string,
): Promise<WebhookResult> {
  const requestId = newCorrelationId();
  let effectiveEnv = env;
  initConfigStore(env);
  // Until the request is verified, nothing but the receiving group's own row
  // is read (fresh): an unsigned flood must not read the whole configuration
  // each time. The full snapshot is read once the event is accepted.
  const provider = detectProvider(headers);
  if (!provider) {
    return { status: 400, body: { error: "Unknown webhook provider" } };
  }
  let tenant: Group | undefined;
  if (tenantId) {
    const found = await loadGroupFresh(env, tenantId);
    if (!found.group) {
      // Unreadable is not missing: the sender is asked to retry.
      if (found.unreadable) {
        return { status: 503, body: { error: "Group configuration unreadable; retry later" } };
      }
      return { status: 404, body: { error: "Group not found" } };
    }
    tenant = found.group;
    const secret = await getTenantSecret(env.KV, tenant);
    if (!secret) {
      return { status: 404, body: { error: "Webhook disabled for this group" } };
    }
    effectiveEnv = { ...env, GITHUB_WEBHOOK_SECRET: secret, GITEA_WEBHOOK_SECRET: secret };
  }

  let verified = false;
  try {
    verified = await provider.verify(body, headers, effectiveEnv);
  } catch (err) {
    if (err instanceof ReplayPendingError) {
      // The nonce is held by an attempt not (yet) accepted: not a replay.
      return { status: 503, body: { error: "Request is already being processed; retry later" } };
    }
    // A malformed secret or an unavailable crypto implementation must fail as
    // a clean 401, never an uncaught 500.
    log.warn(
      { provider: provider.id, requestId, err: String(err) },
      "Webhook signature verification failed",
    );
    return { status: 401, body: { error: "Invalid signature" } };
  }
  if (!verified) {
    // Log the actual cause: a missing provider secret is a deployment problem,
    // while a mismatched signature usually means the sender used the wrong secret.
    const secret =
      provider.id === "gitea"
        ? effectiveEnv.GITEA_WEBHOOK_SECRET
        : effectiveEnv.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      log.warn(
        { provider: provider.id, requestId },
        "Webhook rejected: provider secret is not configured",
      );
    } else {
      log.warn({ provider: provider.id, requestId }, "Webhook rejected: invalid signature");
    }
    return { status: 401, body: { error: "Invalid signature" } };
  }

  // From here on, one-time claims are held (the custom-webhook nonce taken
  // by `verify`, the delivery dedup key). Only once the event is accepted
  // (queued, or dispatched without a transient failure) are they confirmed;
  // otherwise they are given back, so the sender's retry is not refused. A
  // claim that could not be given back is never mistaken for an accepted
  // event: a retry finds it unconfirmed and is asked to come back later.
  const claims = idempotencyStore(env.DB, env.KV);
  const held: { key: string; ttl: number }[] = [];
  const nonce = headers["x-webhooker-nonce"];
  if (provider.id === "custom" && nonce && headers["x-webhooker-timestamp"]) {
    held.push({
      key: await replayNonceKey(effectiveEnv.GITHUB_WEBHOOK_SECRET, nonce),
      ttl: NONCE_TTL_SECONDS,
    });
  }
  const releaseClaims = async (): Promise<void> => {
    for (const { key } of held.splice(0)) {
      await claims.release(key).catch((err: unknown) => {
        log.warn({ requestId, key, err }, "Failed to release a webhook claim");
      });
    }
  };
  const confirmClaims = async (): Promise<void> => {
    for (const { key, ttl } of held.splice(0)) {
      // Unconfirmed, a claim only delays a duplicate until it expires.
      await confirmClaim(claims, key, ttl).catch((err: unknown) => {
        log.warn({ requestId, key, err }, "Failed to confirm a webhook claim");
      });
    }
  };
  const retryLater = (error: string): WebhookResult => ({
    status: 503,
    body: { error, requestId },
  });

  try {
    const event = provider.parse(body, headers);
    if (!event) {
      await releaseClaims();
      return { status: 400, body: { error: "Invalid event" } };
    }
    if (tenantId) event.installationId = undefined;

    // Dedup via the idempotency store: a provider/tenant-scoped key means
    // different accounts may reuse a delivery id without colliding, while
    // retries of the same delivery never dispatch twice. An inline dispatch
    // holds its claim for as long as it may run.
    // A custom sender's ids are namespaced (`d:`) as its delivery identity is
    // below: no id it picks can take the key of a nonce-identified request.
    const dedupKey = event.deliveryId
      ? deliveryKey(
          provider.id,
          tenantId,
          provider.id === "custom" ? `d:${event.deliveryId}` : event.deliveryId,
          tenant?.instance,
        )
      : null;
    if (dedupKey) {
      const ttl = env.QUEUE ? QUEUED_CLAIM_SECONDS : INLINE_CLAIM_SECONDS;
      const state = await claimOnce(claims, dedupKey, ttl);
      if (state === "done") {
        // Already accepted: this request's own nonce is used up as well.
        await confirmClaims();
        return { status: 200, body: { ok: true, duplicate: true, requestId } };
      }
      if (state === "pending") {
        // Still in flight elsewhere, or left over from an attempt that was
        // not accepted: the event may not be on its way yet.
        await releaseClaims();
        return retryLater("Delivery is already being processed; retry later");
      }
      held.push({ key: dedupKey, ttl });
    }

    // Provisioning runs only for an event not yet accepted (a duplicate
    // returned above): a redelivery must not redo a binding an admin undid.
    // Auto-provision GitHub App installations so tenant isolation is
    // configured without manual id entry: a group is created (or existing
    // matching groups are bound) before the event is dispatched. Only events
    // signed with the operator's own secret (the global endpoint) may do this.
    if (
      !tenantId &&
      provider.id === "github" &&
      event.event === "installation" &&
      event.payload.action === "created" &&
      event.installationId != null
    ) {
      const install = event.payload.installation as { account?: { login?: string } } | undefined;
      const account = install?.account?.login ?? "";
      // Done once per installation, on record as long as delivery state is
      // kept: a redelivery after the dedup claim lapsed (minutes) must not
      // redo a binding an admin undid since. Recorded only once it succeeded,
      // so a provisioning that failed midway is completed by the retry.
      const doneKey = `installation-provisioned:${event.installationId}`;
      try {
        if (!(await claims.has(doneKey))) {
          const group = await ensureInstallationGroup(
            env.KV,
            event.installationId,
            account,
            env.DB,
          );
          await claims.claim(doneKey, PROVISIONED_TTL_SECONDS);
          if (group) {
            await recordAudit(env.DB, {
              ts: Date.now(),
              actorLogin: account || undefined,
              action: "installation.created",
              targetType: "group",
              targetId: group.id,
              groupId: group.id,
              groupInstance: group.instance,
            });
          }
        }
      } catch (err) {
        // Not accepted: the consumer never provisions, so a sender retry is
        // the only way the group gets created (provisioning is idempotent).
        log.warn(
          { err, installationId: event.installationId },
          "Failed to auto-provision installation group",
        );
        await releaseClaims();
        return retryLater("Installation provisioning failed; retry later");
      }
    }

    // A stable identity across the sender's retries: the delivery id, else the
    // replay-protection nonce of a signed request. Queued or inline, it keys
    // the delivery's state and target ledger, so a retry of a request whose
    // first attempt went through after all is recognized, not sent again.
    // A custom sender picks its delivery ids freely: they get a namespace of
    // their own, so none can coincide with a nonce-derived identity.
    const nonceKey = held.find((h) => h.key.startsWith("nonce:"))?.key;
    const identity =
      event.deliveryId != null
        ? provider.id === "custom"
          ? `d:${event.deliveryId}`
          : event.deliveryId
        : nonceKey
          ? `n:${nonceKey}`
          : undefined;

    // Inline, a request identified by its nonce alone is held for the whole
    // dispatch, as a delivery id is above: its nonce claim is short (shorter
    // than a long dispatch), and a copy arriving meanwhile must not send the
    // targets not yet on the ledger a second time.
    if (!env.QUEUE && event.deliveryId == null && identity) {
      const key = deliveryKey(provider.id, tenantId, identity, tenant?.instance);
      const state = await claimOnce(claims, key, INLINE_CLAIM_SECONDS);
      if (state === "done") {
        await confirmClaims();
        return { status: 200, body: { ok: true, duplicate: true, requestId } };
      }
      if (state === "pending") {
        await releaseClaims();
        return retryLater("Delivery is already being processed; retry later");
      }
      held.push({ key, ttl: INLINE_CLAIM_SECONDS });
    }

    if (env.QUEUE) {
      const message: DeliveryMessage = {
        deliveryId: identity ?? requestId,
        groupId: tenantId,
        groupInstance: tenant?.instance,
        provider: provider.id,
        event: event.event,
        payload: event.payload,
        installationId: event.installationId,
        receivedAt: Date.now(),
        requestId,
        stateVersion: 2,
      };
      // Acknowledge only once the event is durably queued.
      await enqueueWebhook(env, message);
      await confirmClaims();
      return { status: 200, body: { ok: true, requestId } };
    }

    // Inline dispatch (no queue): there is no durable retry, so the sender
    // is answered only after the dispatch, and asked to retry while a target
    // failed transiently. A delivery id gets a target ledger, so targets
    // already sent are skipped when the sender redelivers.
    // One consistent snapshot of routes and groups serves the dispatch — read
    // fresh: a route or target removed moments ago in another isolate must
    // not still be dispatched to from this isolate's cache.
    const snapshot = await loadConfigSnapshot(env, { fresh: true });
    if (tenantId) {
      const current = snapshot.groups.find((g) => g.id === tenantId);
      if (!current || current.instance !== tenant?.instance) {
        // Gone or replaced since its row was read: not this group's event now.
        await releaseClaims();
        if (snapshot.config.unreadableGroups?.includes(tenantId)) {
          return retryLater("Group configuration unreadable; retry later");
        }
        return { status: 404, body: { error: "Group not found" } };
      }
    }
    const scoped = tenantId
      ? {
          ...snapshot.config,
          routes: snapshot.config.routes.filter((r) => r.groupId === tenantId),
        }
      : snapshot.config;
    const ledgerKey = identity
      ? deliveryStateKey(provider.id, tenantId, identity, tenant?.instance)
      : null;
    const run = (async (): Promise<InlineOutcome> => {
      const recorded = new Set<string>();
      // Dispatched under the delivery's identity (as a queued copy is), so the
      // platform idempotency keys stay the same when the sender retries.
      const delivered = identity ? { ...event, deliveryId: identity } : event;
      // Sending stops well before the claim held for this dispatch expires
      // (a target takes under a minute at worst): a copy arriving after that
      // could otherwise send the targets still in flight. What is left is a
      // transient failure, so the sender retries it (the ledger skips the rest).
      const sendUntil = Date.now() + INLINE_SEND_BUDGET_MS;
      const summary = await dispatchEvent(scoped, delivered, env, snapshot.groups, {
        tenantId,
        beforeTarget: async (): Promise<boolean> => Date.now() < sendUntil,
        skipTarget: ledgerKey ? targetDoneChecker(env, ledgerKey) : undefined,
        afterTarget: ledgerKey
          ? async (targetKey): Promise<void> => {
              await markTargetsDone(env, ledgerKey, [targetKey]);
              recorded.add(targetKey);
            }
          : undefined,
      });
      const permanent = summary.failures.filter((f) => !isRetryableFailure(f));
      if (ledgerKey) {
        await markTargetsDone(
          env,
          ledgerKey,
          [...(summary.succeeded ?? []), ...permanent.flatMap((f) => f.key ?? [])].filter(
            (k) => !recorded.has(k),
          ),
          { permanentFailure: permanent.length > 0 },
        );
      }
      // A transient failure is always retried: without a ledger the retry
      // sends the other targets again too — duplicates rather than a loss.
      return {
        retry: summary.failures.some(isRetryableFailure),
        // Targets that failed for good in an earlier attempt still count.
        failed:
          permanent.length > 0 ||
          (ledgerKey != null && (await hadPermanentFailure(env, ledgerKey))),
      };
    })();
    // The dispatch keeps running should the sender hang up meanwhile.
    waitUntil(run.catch(() => undefined));
    let outcome: InlineOutcome;
    try {
      outcome = await run;
    } catch (err) {
      log.error({ requestId, err }, "Dispatch failed");
      await releaseClaims();
      return retryLater("Dispatch failed; retry later");
    }
    if (outcome.retry) {
      log.warn({ requestId }, "Inline dispatch failed transiently");
      await releaseClaims();
      return retryLater("Some targets failed temporarily; retry later");
    }
    await confirmClaims();
    // Accepted for good; a target that can never take the event is reported.
    return outcome.failed
      ? { status: 200, body: { ok: true, requestId, failed: true } }
      : { status: 200, body: { ok: true, requestId } };
  } catch (err) {
    log.error({ requestId, err }, "Failed to accept webhook");
    await releaseClaims();
    return retryLater("Temporarily unable to accept webhook");
  }
}

/** h3 wrapper for `POST /webhook` / `POST /webhook/:groupId`. */
export async function handleWebhookRequest(event: H3Event, tenantId?: string): Promise<unknown> {
  const contentLength = Number(getHeader(event, "content-length") ?? 0);
  if (contentLength > MAX_BODY_SIZE) {
    setResponseStatus(event, 413);
    return { error: "Request too large" };
  }
  const body = (await readRawBody(event, "utf8")) ?? "";
  if (body.length > MAX_BODY_SIZE) {
    setResponseStatus(event, 413);
    return { error: "Request too large" };
  }
  const result = await processWebhook(
    cfEnv(event),
    body,
    headersFrom(event),
    cfWaitUntil(event),
    tenantId,
  );
  setResponseStatus(event, result.status);
  return result.body;
}
