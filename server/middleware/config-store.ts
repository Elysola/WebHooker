import type { Env } from "../lib/types";
import { initConfigStore } from "../lib/config";

/**
 * Bind the D1-backed configuration store before any handler runs, so no
 * request path (invite acceptance, OAuth callbacks, bot commands, ...) can
 * fall back to the KV-only store and read or write a configuration that
 * diverges from D1.
 */
export default defineEventHandler((event) => {
  const env = (event.context.cloudflare as { env?: Env } | undefined)?.env;
  if (env?.KV) initConfigStore(env);
});
