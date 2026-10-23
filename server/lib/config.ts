import type { Env, Config, Group, Route } from "./types";
import {
  createConfigStore,
  kvConfigStore,
  type ConfigStore,
  type GuardedWrite,
  type LoadOptions,
} from "./storage/config-store";
import { canUseD1 } from "./storage/d1";

const configStores = new WeakMap<KVNamespace, ConfigStore>();

/**
 * The configuration store bound to this KV namespace. Every request, queue
 * batch and scheduled task registers the D1-backed store first (see
 * `initConfigStore`); a namespace that was never registered — a test, or a
 * deployment without D1 — reads and writes the KV-only store.
 */
export function getConfigStore(kv: KVNamespace): ConfigStore {
  return configStores.get(kv) ?? kvConfigStore(kv);
}

export function initConfigStore(env: Env): ConfigStore {
  const existing = configStores.get(env.KV);
  if (existing && (existing.kind === "d1" || !canUseD1(env.DB))) return existing;
  const store = createConfigStore(env.DB, env.KV);
  configStores.set(env.KV, store);
  return store;
}

export function resetConfigStore(kv?: KVNamespace): void {
  if (kv) {
    configStores.get(kv)?.invalidateCache();
    configStores.delete(kv);
  }
}

export async function loadRoutes(kv: KVNamespace, opts?: LoadOptions): Promise<Route[]> {
  return getConfigStore(kv).loadRoutes(opts);
}

export async function saveRoutes(kv: KVNamespace, routes: Route[]): Promise<void> {
  await getConfigStore(kv).saveRoutes(routes);
}

export async function saveGroupRoutes(
  kv: KVNamespace,
  groupId: string,
  routes: Route[],
  opts?: GuardedWrite<Route[]>,
): Promise<Route[]> {
  return getConfigStore(kv).saveGroupRoutes(groupId, routes, opts);
}

/** Drop every cached configuration snapshot held by this isolate. */
export function invalidateConfigCache(kv?: KVNamespace): void {
  if (kv) configStores.get(kv)?.invalidateCache();
}

/** One group, read fresh (its row alone): see `ConfigStore.loadGroup`. */
export function loadGroupFresh(
  env: Env,
  id: string,
): Promise<{ group: Group | null; unreadable: boolean }> {
  return initConfigStore(env).loadGroup(id);
}

/**
 * Configuration and groups of one consistent moment, for a dispatch that
 * needs both (routes of a renamed group must never meet its old id, nor new
 * targets meet stale source restrictions).
 */
export async function loadConfigSnapshot(
  env: Env,
  opts?: LoadOptions,
): Promise<{ config: Config; groups: Group[] }> {
  const store = initConfigStore(env);
  const { routes, groups, unreadable } = await store.loadSnapshot(opts);
  const config = buildConfig(env, routes);
  if (unreadable?.length) config.unreadableGroups = unreadable;
  return { config, groups };
}

/**
 * The configuration for one dispatch. Each call returns a fresh object with
 * its own `routes` array, so a caller narrowing the routes (tenant scoping)
 * can never leak that change into another request served by this isolate.
 */
export async function loadConfig(env: Env): Promise<Config> {
  initConfigStore(env);
  return buildConfig(env, await loadRoutes(env.KV));
}

function buildConfig(env: Env, routes: Route[]): Config {
  return {
    baseUrl: env.BASE_URL ?? "https://webhooker.example.workers.dev",
    github: {
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      appId: Number(env.GITHUB_APP_ID ?? 0),
      privateKey: env.GITHUB_PRIVATE_KEY ?? "",
      clientId: env.GITHUB_CLIENT_ID ?? "",
      clientSecret: env.GITHUB_CLIENT_SECRET ?? "",
    },
    discord: {
      token: env.DISCORD_TOKEN ?? "",
    },
    routes: [...routes],
  };
}
