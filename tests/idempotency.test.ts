import { describe, it, expect } from "bun:test";
import { deliveryKey, kvIdempotencyStore } from "../server/lib/lib/idempotency";

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

describe("deliveryKey", () => {
  it("includes provider, tenant and delivery id", () => {
    expect(deliveryKey("github", "team-a", "deliv-1")).toBe("delivery:github:team-a:deliv-1");
  });

  it("uses a scope no group id can take without a tenant", () => {
    expect(deliveryKey("github", undefined, "deliv-1")).toBe("delivery:github:@global:deliv-1");
    expect(deliveryKey("github", "global", "deliv-1")).toBe("delivery:github:global:deliv-1");
  });
});

describe("kvIdempotencyStore", () => {
  it("claims a key once and reports it thereafter", async () => {
    const kv = createMockKV();
    const store = kvIdempotencyStore(kv);
    expect(await store.has("k")).toBe(false);
    expect(await store.claim("k", 300)).toBe(true);
    expect(await store.has("k")).toBe(true);
    expect(await store.claim("k", 300)).toBe(false);
  });

  it("stores the claimed key with the requested TTL", async () => {
    const kv = createMockKV();
    let ttl = 0;
    (kv.put as unknown) = async (
      key: string,
      value: string,
      opts?: { expirationTtl?: number },
    ): Promise<void> => {
      ttl = opts?.expirationTtl ?? 0;
    };
    const store = kvIdempotencyStore(kv);
    await store.claim("k", 600);
    expect(ttl).toBe(600);
  });

  it("treats distinct keys independently", async () => {
    const store = kvIdempotencyStore(createMockKV());
    expect(await store.claim("a", 300)).toBe(true);
    expect(await store.claim("b", 300)).toBe(true);
    expect(await store.claim("a", 300)).toBe(false);
  });
});
