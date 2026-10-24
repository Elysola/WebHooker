import type { Config, Env, Group, WebhookEvent, WebhookProvider } from "../types";
import { dispatchEvent, type DispatchOptions } from "../core/dispatch";
import { loadConfigSnapshot, loadGroupFresh } from "../config";
import { groupAliasChain } from "../web/group-lifecycle";
import { log } from "../lib/log";
import { recordSendBatch } from "../lib/send-log-batch";
import {
  DELIVERY_DLQ,
  PayloadUnavailableError,
  type DeliveryMessage,
  type DispatchSummary,
  acquireDelivery,
  classifyDelivery,
  finishLease,
  getDeliveryState,
  renewLease,
  type DeliveryStatus,
  deliveryStateKey,
  discardPayload,
  hadPermanentFailure,
  isRetryableFailure,
  markDeliveryDead,
  markTargetsDone,
  resolvePayload,
  retryDelay,
  targetDoneChecker,
} from "./delivery";

type Dispatch = (
  config: Config,
  event: WebhookEvent,
  env: Env,
  groups?: Group[],
  options?: DispatchOptions,
) => Promise<DispatchSummary>;

export async function handleQueueBatch(
  batch: MessageBatch<DeliveryMessage>,
  env: Env,
  dispatch: Dispatch = dispatchEvent,
  budgetMs = BATCH_BUDGET_MS,
): Promise<void> {
  // Shared by the whole batch: the limits it guards (D1 queries and
  // subrequests) are per invocation.
  const budget: BatchBudget = { deadline: Date.now() + budgetMs, sendsLeft: BATCH_SEND_LIMIT };
  for (const message of batch.messages) {
    const body = message.body;
    try {
      if (batch.queue === DELIVERY_DLQ) {
        if (await markDead(env, body)) message.ack();
        // Another copy holds a live lease and may still need the payload.
        else message.retry({ delaySeconds: BUSY_RETRY_SECONDS });
        continue;
      }
      // Out of time or sends before it started (earlier messages took them):
      // back to the queue for a later invocation — a retry (one more queue
      // read), not a copy (a write and a delete more). Waiting is not a
      // failure, though: a delivery never started whose retry would use up
      // its last one (sending it to the DLQ untried) is copied instead. One
      // that was started has real failures among its attempts; a copy would
      // start their count over, so it keeps the retry.
      if (spent(budget)) {
        if (message.attempts > QUEUE_MAX_RETRIES && env.QUEUE && (await neverStarted(env, body))) {
          try {
            await env.QUEUE.send(body, { delaySeconds: CONTINUE_DELAY_SECONDS });
            message.ack();
            continue;
          } catch (err) {
            log.warn({ deliveryId: body.deliveryId, err }, "Failed to queue a delivery for later");
          }
        }
        message.retry({ delaySeconds: CONTINUE_DELAY_SECONDS });
        continue;
      }
      await processMessage(env, body, message, dispatch, budget);
    } catch (err) {
      // One message's storage failure must not fail (and replay) the batch.
      log.error({ deliveryId: body.deliveryId, err }, "Queue message handling failed");
      message.retry({ delaySeconds: retryDelay(message.attempts) });
    }
  }
}

/** Renew a held lease when it is older than this (the lease lasts five minutes). */
const LEASE_RENEW_MS = 60_000;
const FINAL: ReadonlySet<DeliveryStatus> = new Set(["delivered", "failed", "dead"]);

/** Wait for an unexpired lease of another consumer: its full length plus a margin. */
const BUSY_RETRY_SECONDS = 310;
/**
 * Sending time of one batch: a consumer invocation may run 15 minutes, and a
 * target takes under a minute at worst (bounded platform calls), so sending
 * stops in time to record what was done.
 */
const BATCH_BUDGET_MS = 12 * 60_000;
/**
 * Targets one batch sends at most: each costs D1 queries (its ledger record,
 * an update chain's lock and tracking) and subrequests, and one invocation
 * may make only 50 of each on Workers Free (with ~7 D1 queries per delivery
 * besides; batches are small, see wrangler.jsonc). A message left unstarted
 * goes back to the queue (a retry: one queue read); a message cut short is
 * continued by a new one only when it made progress.
 */
const BATCH_SEND_LIMIT = 20;

/** What a batch may still spend: its time and its sends. */
interface BatchBudget {
  deadline: number;
  sendsLeft: number;
}

function spent(budget: BatchBudget): boolean {
  return Date.now() >= budget.deadline || budget.sendsLeft <= 0;
}
const CONTINUE_DELAY_SECONDS = 5;
/** The delivery queue's `max_retries` (`wrangler.jsonc`). */
const QUEUE_MAX_RETRIES = 5;

/** No attempt has taken the delivery's lease yet (its attempts were all waits). */
async function neverStarted(env: Env, body: DeliveryMessage): Promise<boolean> {
  const key = deliveryStateKey(body.provider, body.groupId, body.deliveryId, body.groupInstance);
  const state = await getDeliveryState(env, key);
  return state == null || state === "pending";
}

/** Clean up after a terminal state; a failure must not reopen the delivery. */
async function discardQuietly(env: Env, body: DeliveryMessage): Promise<void> {
  await discardPayload(env, body).catch((err) =>
    log.warn({ deliveryId: body.deliveryId, err }, "Failed to discard a parked payload"),
  );
}

async function processMessage(
  env: Env,
  body: DeliveryMessage,
  message: Message<DeliveryMessage>,
  dispatch: Dispatch,
  budget: BatchBudget,
): Promise<void> {
  const key = deliveryStateKey(body.provider, body.groupId, body.deliveryId, body.groupInstance);
  if (await finishedUnderLegacyKey(env, body)) {
    message.ack();
    return;
  }
  const lease = await acquireDelivery(env, key);
  if (lease.status === "finished") {
    message.ack();
    return;
  }
  if (lease.status === "busy") {
    // Another consumer holds this delivery (or a holder vanished): one retry
    // after the lease surely expired, instead of spending the retry budget
    // polling a lease that is still valid.
    message.retry({ delaySeconds: BUSY_RETRY_SECONDS });
    return;
  }

  let token = lease.token;
  let renewedAt = Date.now();
  let leaseLost = false;
  /** A renewal failed with an unknown outcome: stop sending, but never assume a new holder. */
  let leaseUncertain = false;
  let renewing: Promise<boolean> | null = null;
  /** The batch's budget ran out: the rest is left to a continuation message. */
  let outOfTime = false;
  /** End this attempt with `status`; acks instead when the lease was lost. */
  const finish = async (status: DeliveryStatus, then: "ack" | "retry"): Promise<void> => {
    const owned = !leaseLost && (await finishLease(env, key, token, status));
    if (owned && then === "retry") {
      message.retry({ delaySeconds: retryDelay(message.attempts) });
      return;
    }
    if (!owned && !leaseLost) {
      // The outcome could not be written, yet no new holder is known (our own
      // renewal may have gone through unseen, or the lease lapsed unnoticed):
      // come back once any lease surely expired; the state then decides.
      message.retry({ delaySeconds: BUSY_RETRY_SECONDS });
      return;
    }
    // Lost lease: the new holder owns the delivery (and its outcome).
    message.ack();
    if (owned && FINAL.has(status)) await discardQuietly(env, body);
  };

  let summary: DispatchSummary;
  // Targets recorded as sent the moment they were sent (see `afterTarget`).
  const recorded = new Set<string>();
  try {
    const payload = await resolvePayload(env, body);
    const event: WebhookEvent = {
      event: body.event,
      payload,
      deliveryId: body.deliveryId,
      provider: body.provider as WebhookProvider,
      installationId: body.installationId,
    };
    // Read fresh, not from this isolate's cache: a group (or route) created
    // moments ago elsewhere must not be taken for missing — for a tenant
    // delivery that verdict is final.
    const { config, groups } = await loadConfigSnapshot(env, { fresh: true });
    // A tenant delivery belongs to the group instance that received it — under
    // whatever id it has now — and never to another group that took over the
    // id since. A message from before instances belongs to the group that had
    // its id back then (`legacyId`), also when that group was renamed before
    // instances existed (followed through the rename aliases) — never to a
    // group created since or renamed to the id.
    let tenantId = body.groupId;
    if (tenantId && body.groupInstance) {
      tenantId = groups.find((g) => g.instance === body.groupInstance)?.id;
    } else if (tenantId) {
      const owner = (id: string): string | undefined => groups.find((g) => g.legacyId === id)?.id;
      let found = owner(tenantId);
      for (const id of found ? [] : (await groupAliasChain(env, tenantId)).slice(1)) {
        found ??= owner(id);
      }
      tenantId = found;
    }
    if (body.groupId && (!tenantId || !groups.some((g) => g.id === tenantId))) {
      // A group row that cannot be read may be the tenant: retry until it is
      // repaired rather than give the delivery up as one of a deleted group.
      if (config.unreadableGroups?.length) {
        log.error(
          { deliveryId: body.deliveryId, unreadable: config.unreadableGroups },
          "Tenant unresolved while some group configuration is unreadable",
        );
        await finish("retrying", "retry");
        return;
      }
      // The group was deleted: nothing can receive the event any more.
      log.warn({ deliveryId: body.deliveryId, groupId: body.groupId }, "Tenant group is gone");
      await finish("failed", "ack");
      return;
    }
    const options: DispatchOptions = {
      tenantId,
      // Always consult the ledger: another queue message of the same delivery
      // (a sender redelivery) may already have sent some targets.
      skipTarget: targetDoneChecker(env, key),
      // Keep the lease alive during a long dispatch; once it is lost, stop
      // sending (the new holder takes over the remaining targets).
      beforeTarget: async () => {
        if (leaseLost || leaseUncertain || outOfTime) return false;
        if (spent(budget)) {
          outOfTime = true;
          return false;
        }
        budget.sendsLeft--;
        if (Date.now() - renewedAt < LEASE_RENEW_MS) return true;
        // Routes run in parallel: they share one renewal. Two renewals with
        // the same token would race, and the loser would take its own
        // successful renewal for a lost lease.
        renewing ??= (async (): Promise<boolean> => {
          try {
            token = await renewLease(env, key, token);
            renewedAt = Date.now();
            leaseLost = token == null && lease.token != null;
            return !leaseLost;
          } catch (err) {
            log.warn({ deliveryId: body.deliveryId, err }, "Lease renewal failed");
            leaseUncertain = true;
            return false;
          } finally {
            renewing = null;
          }
        })();
        return renewing;
      },
      afterTarget: async (targetKey) => {
        await markTargetsDone(env, key, [targetKey]);
        recorded.add(targetKey);
      },
    };
    const scoped = tenantId
      ? { ...config, routes: config.routes.filter((r) => r.groupId === tenantId) }
      : config;
    summary = await dispatch(scoped, event, env, groups, options);
  } catch (err) {
    if (err instanceof PayloadUnavailableError) {
      // Nothing left to dispatch in this message: drop it, loudly, without
      // retrying forever or pretending the delivery succeeded. The delivery
      // stays open (not final): the sender's redelivery, with its own payload,
      // can still deliver it.
      log.error({ deliveryId: body.deliveryId, err: err.message }, "Queued payload unavailable");
      // On record where admins look (the group's send log and failure
      // metrics): the event needs a redelivery from its sender.
      await recordSendBatch(env.DB, [
        {
          ts: Date.now(),
          routeId: "",
          groupId: body.groupId,
          groupInstance: body.groupInstance,
          event: body.event,
          target: "",
          ok: false,
          error: `${err.message}; redeliver the webhook to send it`,
          errorCode: "PAYLOAD_MISSING",
          deliveryId: body.deliveryId,
        },
      ]);
      await finish("retrying", "ack");
      return;
    }
    log.error({ deliveryId: body.deliveryId, err }, "Queue delivery failed");
    await finish("retrying", "retry");
    return;
  }

  const { failed, retryable } = classifyDelivery(summary);
  // Record finished targets first, whatever comes next: if a later write
  // fails and the message is retried, these targets are never sent again.
  const permanent = summary.failures.filter((f) => !isRetryableFailure(f));
  try {
    await markTargetsDone(
      env,
      key,
      [...(summary.succeeded ?? []), ...permanent.flatMap((f) => f.key ?? [])].filter(
        (k) => !recorded.has(k),
      ),
      { permanentFailure: permanent.length > 0 },
    );
  } catch (err) {
    // The outcome is not on record: retry (giving the lease back now) rather
    // than finish the delivery with a forgotten permanent failure.
    log.error({ deliveryId: body.deliveryId, err }, "Failed to record delivery targets");
    await finish("retrying", "retry");
    return;
  }
  if (failed && retryable) {
    // Stopped for time, not for a failure: continued by a new message (sent
    // before the lease is given back; a lease still held only delays it) —
    // only when this attempt finished targets. One that made no progress
    // (its targets kept failing until time ran out) is an ordinary retry and
    // counts against the retry limit, so it cannot loop forever.
    const progressed = (summary.succeeded?.length ?? 0) > 0 || permanent.length > 0;
    if (outOfTime && progressed && !leaseLost && env.QUEUE) {
      try {
        await env.QUEUE.send(body, { delaySeconds: CONTINUE_DELAY_SECONDS });
        await finish("retrying", "ack");
        return;
      } catch (err) {
        log.warn({ deliveryId: body.deliveryId, err }, "Failed to queue the rest of a delivery");
      }
    }
    await finish("retrying", "retry");
    return;
  }
  // Targets that failed for good in an earlier attempt still count.
  const anyPermanent = failed || (await hadPermanentFailure(env, key));
  await finish(anyPermanent ? "failed" : "delivered", "ack");
}

/**
 * The delivery already finished under the state key used before deliveries
 * were scoped by `@global` / group instance (`delivery-state:{provider}:
 * {groupId | "global"}:{id}`, kept 7 days): a sender's redelivery of an event
 * handled before the upgrade is then not sent again. The old key is only
 * trusted where its owner is certain — for a tenant, the group that had the
 * id back then (its `legacyId`); for the global endpoint, while no group named
 * "global" (which used the same key) exists or was deleted or renamed away
 * recently.
 */
async function finishedUnderLegacyKey(env: Env, body: DeliveryMessage): Promise<boolean> {
  // The global endpoint's old key was shared with any tenant once named
  // "global" — even one deleted before the upgrade, which nothing records:
  // its owner is never certain, so it is never trusted (a redelivery is sent
  // again rather than an event dropped). Nothing to read for it, then.
  if (!body.groupId || body.groupId === "global") return false;
  // The store's one-time setup (seeding from KV, which also turns on reading
  // older KV state) must have run before state is read: one group row reads
  // it in, not the whole configuration (read below only when it matters).
  const { group } = await loadGroupFresh(env, body.groupId);
  // The message's own group, still under this id, with no older id of the
  // same name (a group created since): nothing it could have finished under
  // the old key, so that key is not read.
  if (
    body.groupInstance &&
    group?.instance === body.groupInstance &&
    group.legacyId !== body.groupId
  ) {
    return false;
  }
  // Custom delivery ids got a namespace since (`d:`; `n:` for nonce
  // identities, which did not exist before) — in messages queued since. A
  // message queued before carries the id as the sender sent it, prefix-like
  // text included.
  const namespaced = body.provider === "custom" && (body.stateVersion ?? 0) >= 2;
  if (namespaced && body.deliveryId.startsWith("n:")) return false;
  const id =
    namespaced && body.deliveryId.startsWith("d:") ? body.deliveryId.slice(2) : body.deliveryId;
  const legacy = `delivery-state:${body.provider}:${body.groupId ?? "global"}:${id}`;
  const state = await getDeliveryState(env, legacy);
  if (!state || !FINAL.has(state)) return false;
  // (A tenant named "global" shared this very key with the global endpoint:
  // refused above.)
  const { groups } = await loadConfigSnapshot(env, { fresh: true });
  const owner = body.groupInstance
    ? groups.find((g) => g.instance === body.groupInstance)
    : groups.find((g) => g.legacyId === body.groupId);
  return owner?.legacyId === body.groupId;
}

/**
 * Settle a message that left the DLQ; false while another copy of the
 * delivery holds a live lease (its state and payload are left alone then).
 */
async function markDead(env: Env, body: DeliveryMessage): Promise<boolean> {
  const key = deliveryStateKey(body.provider, body.groupId, body.deliveryId, body.groupInstance);
  // A delivery another message of it finished (or is sending) keeps its state.
  if ((await markDeliveryDead(env, key)) === "busy") return false;
  await discardPayload(env, body);
  return true;
}
