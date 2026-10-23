import type { Env } from "../lib/types";
import { handleQueueBatch } from "../lib/queue/consumer";
import { initConfigStore } from "../lib/config";

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("cloudflare:queue", async ({ batch, env }) => {
    initConfigStore(env as Env);
    await handleQueueBatch(batch, env as Env);
  });
});
