import { readRawBody } from "h3";
import { handleTelegramWebhookRequest } from "../../lib/drivers/telegram/updates";
import { cfEnv, declaresBodyOver, rawRequest } from "../../lib/cf";

export default defineEventHandler(async (event) => {
  if (declaresBodyOver(event)) return new Response("Request too large", { status: 413 });
  const source = rawRequest(event);
  const body = await readRawBody(event, "utf8");
  const request = new Request(source.url, {
    method: source.method,
    headers: source.headers,
    body,
  });
  return handleTelegramWebhookRequest(request, cfEnv(event));
});
