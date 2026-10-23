import { readRawBody } from "h3";
import { handleInteractionRequest } from "../../lib/drivers/discord/interactions";
import { cfEnv, declaresBodyOver, rawRequest } from "../../lib/cf";

export default defineEventHandler(async (event) => {
  // The raw Request is provided for headers/URL, but nitro consumes its body
  // while buffering the payload — rebuild a fresh Request with the body from
  // h3's internal buffers so the handler can read it (signature verification
  // needs the exact raw bytes).
  if (declaresBodyOver(event)) return new Response("Request too large", { status: 413 });
  const source = rawRequest(event);
  const body = await readRawBody(event, "utf8");
  const request = new Request(source.url, {
    method: source.method,
    headers: source.headers,
    body,
  });
  return handleInteractionRequest(request, cfEnv(event));
});
