import { describe, it, expect } from "bun:test";
import { kvMessageTracker } from "../server/lib/lib/message-tracker";

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, value);
      if (opts?.expirationTtl) ttl.set(key, opts.expirationTtl);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
}

describe("kvMessageTracker", () => {
  it("stores and retrieves a message id by event and target", async () => {
    const kv = createMockKV();
    const tracker = kvMessageTracker(kv);
    await tracker.set("route-1:workflow-9", "channel-1", { messageId: "msg-42", version: 5 });
    expect(await tracker.get("route-1:workflow-9", "channel-1")).toEqual({
      messageId: "msg-42",
      version: 5,
    });
  });

  it("returns null for an unknown event/target", async () => {
    const kv = createMockKV();
    const tracker = kvMessageTracker(kv);
    expect(await tracker.get("missing", "channel-1")).toBeNull();
  });

  it("uses the msg:{eventId}:{targetId} key with a 30-day TTL", async () => {
    const kv = createMockKV();
    const keys = new Map<string, string>();
    const ttls = new Map<string, number>();
    (kv.put as unknown) = async (
      key: string,
      value: string,
      opts?: { expirationTtl?: number },
    ): Promise<void> => {
      keys.set(key, value);
      ttls.set(key, opts?.expirationTtl ?? 0);
    };
    const tracker = kvMessageTracker(kv);
    await tracker.set("event-1", "target-1", { messageId: "msg-7", version: 0 });
    expect(keys.has("msg:event-1:target-1")).toBe(true);
    expect(ttls.get("msg:event-1:target-1")).toBe(30 * 86400);
  });

  it("deletes tracked entries", async () => {
    const kv = createMockKV();
    const tracker = kvMessageTracker(kv);
    await tracker.set("event-1", "target-1", { messageId: "msg-7", version: 0 });
    await tracker.delete("event-1", "target-1");
    expect(await tracker.get("event-1", "target-1")).toBeNull();
  });
});
