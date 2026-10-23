import { describe, it, expect, beforeEach } from "bun:test";
import { handleQueueBatch } from "../server/lib/queue/consumer";
import { invalidateConfigCache } from "../server/lib/config";
import { invalidateGroupsCache } from "../server/lib/web/groups";
import type { Env } from "../server/lib/types";
import type { DeliveryMessage, DispatchSummary } from "../server/lib/queue/delivery";

let summary: DispatchSummary;
let dispatchCalls: number;

async function fakeDispatch(..._args: unknown[]): Promise<DispatchSummary> {
  dispatchCalls += 1;
  return summary;
}

function createMockKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
  return { kv, store };
}

function createEnv(kv: KVNamespace): Env {
  return {
    GITHUB_WEBHOOK_SECRET: "secret",
    KV: kv,
    DB: {} as D1Database,
  };
}

interface FakeMessage {
  body: DeliveryMessage;
  attempts: number;
  acked: boolean;
  retried: { delaySeconds?: number } | null;
  ack: () => void;
  retry: (opts?: { delaySeconds?: number }) => void;
}

function makeMessage(body: DeliveryMessage, attempts = 1): FakeMessage {
  return {
    body,
    attempts,
    acked: false,
    retried: null,
    ack(): void {
      this.acked = true;
    },
    retry(opts): void {
      this.retried = opts ?? {};
    },
  };
}

function makeBatch(queue: string, messages: FakeMessage[]): MessageBatch<DeliveryMessage> {
  return {
    queue,
    messages: messages as never,
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<DeliveryMessage>;
}

function body(overrides: Partial<DeliveryMessage> = {}): DeliveryMessage {
  return {
    deliveryId: "d1",
    provider: "github",
    event: "push",
    payload: { ref: "refs/heads/main" },
    receivedAt: Date.now(),
    ...overrides,
  };
}

const STATE_KEY = "delivery-state:github:@global:d1";

describe("handleQueueBatch", () => {
  beforeEach(() => {
    invalidateConfigCache();
    invalidateGroupsCache();
    summary = { attempts: 0, failures: [] };
    dispatchCalls = 0;
  });

  it("marks DLQ messages dead and acks them", async () => {
    const { kv, store } = createMockKV();
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery-dlq", [msg]), createEnv(kv), fakeDispatch);
    expect(msg.acked).toBe(true);
    expect(JSON.parse(store.get(STATE_KEY)!)).toMatchObject({ status: "dead" });
  });

  it("acks and marks delivered on success", async () => {
    const { kv, store } = createMockKV();
    summary = { attempts: 1, failures: [] };
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBeNull();
    expect(JSON.parse(store.get(STATE_KEY)!)).toMatchObject({ status: "delivered" });
  });

  it("retries with backoff on a retryable failure", async () => {
    const { kv, store } = createMockKV();
    summary = { attempts: 2, failures: [{ target: "c1", errorCode: "DISCORD_5XX" }] };
    const msg = makeMessage(body(), 1);
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    expect(msg.acked).toBe(false);
    expect(msg.retried).toEqual({ delaySeconds: 5 });
    expect(JSON.parse(store.get(STATE_KEY)!)).toMatchObject({ status: "retrying" });
  });

  it("acks and marks failed on a permanent failure", async () => {
    const { kv, store } = createMockKV();
    summary = { attempts: 2, failures: [{ target: "c1", errorCode: "DISCORD_ERROR" }] };
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    expect(msg.acked).toBe(true);
    expect(msg.retried).toBeNull();
    expect(JSON.parse(store.get(STATE_KEY)!)).toMatchObject({ status: "failed" });
  });

  it("skips already-delivered deliveries without re-dispatching", async () => {
    const { kv, store } = createMockKV();
    store.set(STATE_KEY, JSON.stringify({ status: "delivered", at: Date.now() }));
    const msg = makeMessage(body());
    await handleQueueBatch(makeBatch("webhooker-delivery", [msg]), createEnv(kv), fakeDispatch);
    expect(msg.acked).toBe(true);
    expect(dispatchCalls).toBe(0);
  });
});
