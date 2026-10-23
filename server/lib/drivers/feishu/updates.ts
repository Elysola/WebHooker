import type { Env } from "../../types";
import { log } from "../../lib/log";
import {
  getOAuthURL,
  commentAsUser,
  mergePullRequestAsUser,
  closePullRequestAsUser,
  BeforeGitHubError,
  CommandTakenError,
  githubRefused,
} from "../../github/oauth";
import { getFeishuLink, unlinkAsCommand } from "../../github/store";
import { acceptedKey, claimOnce, confirmClaim, idempotencyStore } from "../../lib/idempotency";
import { forgetRejectedToken, getTenantAccessToken, sendText, updateCard } from "./rest";

const FEISHU_API = "https://open.feishu.cn";
const MAX_BODY_SIZE = 1024 * 1024;
/** Handled event ids are remembered this long; replays of older requests are refused. */
const EVENT_CLAIM_SECONDS = 86400;
/** An event is held this long while it runs (then a retry may take it). */
const EVENT_PROCESSING_SECONDS = 300;
/**
 * Oldest signed request accepted. It stays well inside the event claim, so a
 * request old enough for its claim to have expired can never run again,
 * while Feishu's own retries (spread over hours) still pass.
 */
const MAX_REQUEST_AGE_SECONDS = 12 * 3600;
const MAX_CLOCK_SKEW_SECONDS = 300;

// github.com itself only (never e.g. `evilgithub.com`): actions hit the GitHub API.
const GITHUB_TARGET_RE =
  /https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/;
const BTN_PREFIX = "ghpr|";

interface FeishuSender {
  sender_id?: { open_id?: string; union_id?: string };
}
interface FeishuMessage {
  chat_id?: string;
  /** "p2p" for the private chat with the bot, "group" otherwise. */
  chat_type?: string;
  content?: string;
}
interface FeishuAction {
  action_id?: string;
  value?: { v?: string };
}
interface FeishuEvent {
  sender?: FeishuSender;
  message?: FeishuMessage;
  action?: FeishuAction;
  /** `card.action.trigger` (schema 2.0): the clicking user is `operator.open_id`. */
  operator?: { open_id?: string; operator_id?: { open_id?: string } };
  token?: string;
  open_message_id?: string;
  context?: { open_message_id?: string };
}

/** Tracks whether a command reached GitHub, so a failed run knows if it may be retried. */
interface CommandRun {
  acted: boolean;
  /** Records the command as done right before its GitHub write. */
  beforeWrite?: () => Promise<void>;
  /** This run wrote the "done" (only then may it give it back). */
  markedDone?: boolean;
  /** The command's "done" record, for writes committed together with it. */
  done?: { key: string; ttl: number };
}

function splitThree(rest: string): [string, string, string] {
  const parts = rest.split("|");
  const number = parts.pop() ?? "";
  const repo = parts.pop() ?? "";
  const owner = parts.pop() ?? "";
  return [owner, repo, number];
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Feishu event signature (when an Encrypt Key is configured): `X-Lark-Signature`
 * is the hex SHA-256 of `timestamp + nonce + encryptKey + rawBody`, with the
 * timestamp and nonce from `X-Lark-Request-Timestamp` / `X-Lark-Request-Nonce`.
 */
export async function verifyFeishuSignature(
  encryptKey: string,
  timestamp: string,
  nonce: string,
  body: string,
  signature: string,
): Promise<boolean> {
  if (!signature) return false;
  const computed = await sha256Hex(`${timestamp}${nonce}${encryptKey}${body}`);
  return timingSafeEqual(computed, signature.toLowerCase());
}

function base64ToBytes(value: string): Uint8Array {
  const bin = atob(value);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Decrypt an `{"encrypt": "..."}` body: AES-256-CBC with key SHA-256(encryptKey)
 * and the IV in the first 16 bytes of the base64-decoded ciphertext.
 */
export async function decryptFeishuPayload(encryptKey: string, encrypted: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptKey));
  const data = base64ToBytes(encrypted);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
    "decrypt",
  ]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: data.slice(0, 16) },
    key,
    data.slice(16),
  );
  return new TextDecoder().decode(plain);
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("GITHUB_TOKEN_EXPIRED")) return "GitHub 绑定已过期，请重新用 /gh login 绑定。";
    if (msg.includes("GITHUB_FORBIDDEN"))
      return "没有权限操作该仓库（GitHub 返回 403），请确认你的账号权限。";
    if (msg.includes("GITHUB_NOT_FOUND")) return "未找到对应的 GitHub 资源（404）。";
    return msg || "操作失败";
  }
  return "操作失败";
}

function extractTarget(text: string): { owner: string; repo: string; number: number } | null {
  const m = text.match(GITHUB_TARGET_RE);
  if (!m) return null;
  const number = Number(m[3] ?? "");
  if (!Number.isInteger(number)) return null;
  return { owner: m[1] ?? "", repo: m[2] ?? "", number };
}

/** Whether a failed reply may succeed later (then the event is given back). */
function replyRetryable(result: { status?: number; errorCode?: string }): boolean {
  if (!result.status || result.status >= 500 || result.status === 429) return true;
  return result.errorCode === "FEISHU_TOKEN" || result.errorCode === "RATE_LIMITED";
}

/**
 * Send a reply. One that could not be sent for now throws, so the event is
 * retried rather than confirmed unanswered (a login link never sent); a
 * refusal that a retry cannot change is logged.
 */
async function replyToken(env: Env, chatId: string, text: string): Promise<void> {
  const tokenRes = await getTenantAccessToken(env);
  if (!tokenRes.ok || !tokenRes.token) {
    log.warn({ err: tokenRes.error }, "Feishu token unavailable for reply");
    throw new Error("Feishu token unavailable for reply");
  }
  const result = await forgetRejectedToken(
    await sendText(tokenRes.token, chatId, text),
    env,
    tokenRes.token,
  );
  if (result.ok) return;
  log.warn({ chatId, err: result.error }, "Feishu reply failed");
  if (replyRetryable(result)) throw new Error(`Feishu reply failed: ${result.error ?? "unknown"}`);
}

async function handleLogin(
  env: Env,
  openId: string,
  chatId: string,
  chatType: string | undefined,
): Promise<void> {
  // An authorization link posted in a group can be opened by anyone there;
  // binding happens in the private chat with the bot only.
  if (chatType !== "p2p") {
    await replyToken(env, chatId, "请私聊机器人发送 /gh login 绑定 GitHub 账号。");
    return;
  }
  const state = crypto.randomUUID();
  const pending = {
    redirectTo: "/admin",
    expiresAt: Date.now() + 10 * 60 * 1000,
    link: { platform: "feishu", userId: openId, chatId },
  };
  await env.KV.put(`state:${state}`, JSON.stringify(pending), { expirationTtl: 600 });
  const url = getOAuthURL(env.GITHUB_CLIENT_ID ?? "", state);
  await replyToken(
    env,
    chatId,
    [
      "点击下方链接绑定 GitHub 账号：",
      url,
      "绑定后可在飞书里用 /gh comment 评论、/gh merge 合并、/gh close 关闭 PR。",
    ].join("\n"),
  );
}

async function handleLogout(
  env: Env,
  openId: string,
  chatId: string,
  run: CommandRun,
): Promise<void> {
  const linked = await getFeishuLink(env.DB, openId);
  if (!linked) {
    await replyToken(env, chatId, "你还没有绑定 GitHub 账号。");
    return;
  }
  await unlinkAsCommand(env, "feishu", openId, run.done);
  // Done from here: should the reply fail, a retry must not unlink again
  // (by then it could remove a link made since).
  run.acted = true;
  await replyToken(env, chatId, "已解绑 GitHub 账号。");
}

async function handleComment(
  env: Env,
  openId: string,
  chatId: string,
  text: string,
  run: CommandRun,
): Promise<void> {
  const githubUserId = await getFeishuLink(env.DB, openId);
  if (!githubUserId) {
    await replyToken(env, chatId, "请先 /gh login 绑定 GitHub 账号。");
    return;
  }
  const target = extractTarget(text);
  if (!target) {
    await replyToken(
      env,
      chatId,
      "请在消息里带上 PR/Issue 链接，例如：/gh comment https://github.com/o/r/pull/7 看起来不错",
    );
    return;
  }
  const ghIdx = text.indexOf("/gh");
  // Only leading space goes: a comment's trailing lines are its own.
  const rest = text.slice(ghIdx + 3).replace(/^\s+/, "");
  // The comment is what follows the link, as written (line breaks and
  // indentation kept).
  const link = /\S*github\.com\S*/.exec(rest);
  const written = (link ? rest.slice(link.index + link[0].length) : rest).replace(
    /^[ \t]*\r?\n?/,
    "",
  );
  const body = written.trim() ? written : "（来自飞书）";
  try {
    const res = await commentAsUser(
      env,
      githubUserId,
      target.owner,
      target.repo,
      target.number,
      body,
      { beforeWrite: run.beforeWrite },
    );
    run.acted = true;
    await replyToken(env, chatId, `✅ 已评论：[查看](${res.htmlUrl})（@${res.login}）`);
  } catch (err) {
    // Nothing reached GitHub yet: give the event back for a retry.
    if (err instanceof BeforeGitHubError) throw err;
    // Done, only its reply failed: the event must not run again.
    if (run.acted) throw err;
    // GitHub was called and may have acted (its answer lost): never run
    // again. A refusal did nothing: should its reply fail, the command is
    // given back and runs again.
    if (!githubRefused(err)) run.acted = true;
    await replyToken(env, chatId, `❌ ${describeError(err)}`);
  }
}

async function handleMergeOrClose(
  env: Env,
  openId: string,
  chatId: string,
  action: "merge" | "close",
  body: string,
  run: CommandRun,
): Promise<void> {
  const githubUserId = await getFeishuLink(env.DB, openId);
  if (!githubUserId) {
    await replyToken(env, chatId, "请先 /gh login 绑定 GitHub 账号。");
    return;
  }
  const target = extractTarget(body);
  if (!target) {
    await replyToken(
      env,
      chatId,
      action === "merge"
        ? "请在消息里带上 PR 链接，例如：/gh merge https://github.com/o/r/pull/7"
        : "请在消息里带上 PR 链接，例如：/gh close https://github.com/o/r/pull/7",
    );
    return;
  }
  try {
    if (action === "merge") {
      await mergePullRequestAsUser(
        env,
        githubUserId,
        target.owner,
        target.repo,
        target.number,
        undefined,
        {
          beforeWrite: run.beforeWrite,
        },
      );
    } else {
      await closePullRequestAsUser(env, githubUserId, target.owner, target.repo, target.number, {
        beforeWrite: run.beforeWrite,
      });
    }
    run.acted = true;
    await replyToken(
      env,
      chatId,
      `✅ 已${action === "merge" ? "合并" : "关闭"} ${target.owner}/${target.repo}#${target.number}`,
    );
  } catch (err) {
    // Nothing reached GitHub yet: give the event back for a retry.
    if (err instanceof BeforeGitHubError) throw err;
    // Done, only its reply failed: the event must not run again.
    if (run.acted) throw err;
    // GitHub was called and may have acted (its answer lost): never run
    // again. A refusal did nothing: should its reply fail, the command is
    // given back and runs again.
    if (!githubRefused(err)) run.acted = true;
    await replyToken(env, chatId, `❌ ${describeError(err)}`);
  }
}

/**
 * The `/gh` command a message carries, or null: only a message that is a
 * command — `/gh` first, after any @mentions of the bot — runs one; quoting
 * or discussing a command never does.
 */
function commandOf(event: FeishuEvent): string | null {
  const message = event.message ?? {};
  let text = "";
  if (message.content) {
    try {
      const content = JSON.parse(message.content) as { text?: string };
      text = content.text ?? "";
    } catch {
      text = "";
    }
  }
  const command = text.replace(/^\s*(?:@\S+\s+)*/, "");
  return /^\/gh(?:\s|$)/.test(command) ? command : null;
}

async function handleMessage(env: Env, event: FeishuEvent, run: CommandRun): Promise<void> {
  const sender = event.sender ?? {};
  const openId = sender.sender_id?.open_id ?? sender.sender_id?.union_id ?? "";
  const message = event.message ?? {};
  const chatId = message.chat_id ?? "";
  const command = commandOf(event);
  if (!command) return;
  const rest = command.slice(3).trim();
  const sub = rest.split(/\s+/)[0] ?? "";
  switch (sub) {
    case "login":
      await handleLogin(env, openId, chatId, message.chat_type);
      break;
    case "logout":
      await handleLogout(env, openId, chatId, run);
      break;
    case "comment":
      await handleComment(env, openId, chatId, command, run);
      break;
    case "merge":
      await handleMergeOrClose(env, openId, chatId, "merge", command, run);
      break;
    case "close":
      await handleMergeOrClose(env, openId, chatId, "close", command, run);
      break;
    default:
      await replyToken(
        env,
        chatId,
        "未知指令。可用：/gh login | logout | comment <链接> <内容> | merge <链接> | close <链接>",
      );
  }
}

function buildResultCard(ok: boolean, message: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: ok ? `✅ ${message}` : `❌ ${message}` },
      },
    ],
  };
}

async function handleCardAction(
  env: Env,
  payload: Record<string, unknown>,
  run: CommandRun,
): Promise<void> {
  const event = (payload.event ?? {}) as FeishuEvent;
  const action = event.action ?? {};
  const actionId = action.action_id ?? action.value?.v ?? "";
  const openId =
    event.operator?.open_id ??
    event.operator?.operator_id?.open_id ??
    event.sender?.sender_id?.open_id ??
    "";
  const cardToken = event.token ?? "";
  const openMessageId = event.context?.open_message_id ?? event.open_message_id ?? "";

  if (!actionId.startsWith(BTN_PREFIX)) return;

  const isMerge = actionId.startsWith(`${BTN_PREFIX}merge|`);
  const isClose = actionId.startsWith(`${BTN_PREFIX}close|`);

  if (isMerge || isClose) {
    const [owner, repo, numberStr] = splitThree(actionId.slice(BTN_PREFIX.length));
    const number = Number(numberStr);
    if (!owner || !repo || !Number.isInteger(number)) {
      await replyCard(env, cardToken, buildResultCard(false, "无效的按钮数据"));
      return;
    }
    const githubUserId = await getFeishuLink(env.DB, openId);
    if (!githubUserId) {
      await replyCard(env, cardToken, buildResultCard(false, "请先 /gh login 绑定 GitHub 账号"));
      return;
    }
    try {
      if (isMerge) {
        await mergePullRequestAsUser(env, githubUserId, owner, repo, number, undefined, {
          beforeWrite: run.beforeWrite,
        });
      } else {
        await closePullRequestAsUser(env, githubUserId, owner, repo, number, {
          beforeWrite: run.beforeWrite,
        });
      }
      run.acted = true;
      await replyCard(
        env,
        cardToken,
        buildResultCard(true, `${isMerge ? "已合并" : "已关闭"} ${owner}/${repo}#${number}`),
      );
    } catch (err) {
      if (err instanceof BeforeGitHubError) throw err;
      // Done, only its card update failed: the event must not run again.
      if (run.acted) throw err;
      // GitHub was called and may have acted (its answer lost): never run
      // again. A refusal did nothing: should its reply fail, the command is
      // given back and runs again.
      if (!githubRefused(err)) run.acted = true;
      await replyCard(env, cardToken, buildResultCard(false, describeError(err)));
    }
    return;
  }

  if (openMessageId) {
    await replyCard(env, cardToken, buildResultCard(false, "未知按钮"));
  }
}

async function replyCard(
  env: Env,
  cardToken: string,
  card: Record<string, unknown>,
): Promise<void> {
  const tokenRes = await getTenantAccessToken(env);
  if (!tokenRes.ok || !tokenRes.token) {
    log.warn({ err: tokenRes.error }, "Feishu token unavailable for card update");
    throw new Error("Feishu token unavailable for card update");
  }
  const result = await forgetRejectedToken(
    await updateCard(tokenRes.token, cardToken, card),
    env,
    tokenRes.token,
  );
  if (result.ok) return;
  log.warn({ err: result.error }, "Failed to update the Feishu card");
  if (replyRetryable(result))
    throw new Error(`Feishu card update failed: ${result.error ?? "unknown"}`);
}

/**
 * Inbound Feishu callbacks (events and card actions). Every request must be
 * authenticated by the app's own credentials before anything runs:
 * - with `FEISHU_ENCRYPT_KEY`, the `X-Lark-Signature` must verify and an
 *   encrypted body is decrypted with that key;
 * - with `FEISHU_VERIFICATION_TOKEN`, the token inside the payload must match.
 * At least one of them is required; without either the endpoint refuses all
 * requests, since an unauthenticated one could act as any linked user.
 */
export async function handleFeishuWebhookRequest(request: Request, env: Env): Promise<Response> {
  // Unauthenticated until verified below: bound what is read and parsed.
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_SIZE) {
    return new Response("Request too large", { status: 413 });
  }
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_SIZE) {
    return new Response("Request too large", { status: 413 });
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const encryptKey = env.FEISHU_ENCRYPT_KEY?.trim() ?? "";
  const verificationToken = env.FEISHU_VERIFICATION_TOKEN?.trim() ?? "";
  if (!encryptKey && !verificationToken) {
    log.warn("Feishu callback refused: FEISHU_ENCRYPT_KEY / FEISHU_VERIFICATION_TOKEN not set");
    return new Response("Feishu callback verification is not configured", { status: 403 });
  }

  if (encryptKey && typeof payload.encrypt === "string") {
    try {
      payload = JSON.parse(await decryptFeishuPayload(encryptKey, payload.encrypt));
    } catch (err) {
      log.warn({ err: String(err) }, "Feishu payload decryption failed");
      return new Response("invalid payload", { status: 400 });
    }
  }

  const header = payload.header as Record<string, unknown> | undefined;
  const eventPart = payload.event as Record<string, unknown> | undefined;
  const type = (payload.type as string) ?? header?.event_type ?? eventPart?.type ?? "";

  // The verification token travels inside the (decrypted) payload: in
  // `header.token` for schema 2.0 events, at the top level otherwise.
  const token = String(header?.token ?? payload.token ?? "");
  if (verificationToken && !timingSafeEqual(token, verificationToken)) {
    log.warn("Feishu verification token mismatch");
    return new Response("invalid token", { status: 401 });
  }

  if (type === "url_verification") {
    return Response.json({ challenge: (payload.challenge as string) ?? "" });
  }

  if (encryptKey) {
    const timestamp = request.headers.get("x-lark-request-timestamp") ?? "";
    // The signature covers the timestamp: a stale one marks a replay that
    // may outlive the event claim below.
    const age = Math.floor(Date.now() / 1000) - Number(timestamp);
    if (!Number.isFinite(age) || age > MAX_REQUEST_AGE_SECONDS || age < -MAX_CLOCK_SKEW_SECONDS) {
      log.warn({ timestamp }, "Feishu callback refused: request timestamp out of range");
      return new Response("stale request", { status: 401 });
    }
    const ok = await verifyFeishuSignature(
      encryptKey,
      timestamp,
      request.headers.get("x-lark-request-nonce") ?? "",
      rawBody,
      request.headers.get("x-lark-signature") ?? "",
    );
    if (!ok) {
      log.warn("Feishu signature verification failed");
      return new Response("invalid signature", { status: 401 });
    }
  }

  const eventType = (header?.event_type as string) ?? eventPart?.type ?? type;
  const isMessage = eventType === "im.message.receive_v1" || eventType === "message";
  // Nothing to do for an ordinary chat message (no `/gh` command) or an
  // event type not handled: answered at once, with no dedup records written
  // (each would be D1 writes for an event that has no side effect).
  if (
    (isMessage && !commandOf((payload.event ?? payload) as FeishuEvent)) ||
    (!isMessage && eventType !== "card.action.trigger")
  ) {
    return new Response("ok", { status: 200 });
  }

  // Feishu retries a callback it considers failed; run each event once. An
  // event whose earlier run is unconfirmed is retried later, never dropped.
  const eventId = String(header?.event_id ?? payload.uuid ?? "");
  const claims = idempotencyStore(env.DB, env.KV);
  const claimKey = `bot:feishu:${eventId}`;
  if (eventId) {
    const state = await claimOnce(claims, claimKey, EVENT_PROCESSING_SECONDS);
    if (state === "done") return new Response("ok", { status: 200 });
    if (state === "pending") return new Response("temporarily unavailable", { status: 503 });
  }

  const run: CommandRun = { acted: false };
  // Done on record before GitHub is written to: should the confirmation
  // after it fail, a retry still never repeats the write.
  if (eventId) {
    run.done = { key: acceptedKey(claimKey), ttl: EVENT_CLAIM_SECONDS };
    run.beforeWrite = async (): Promise<void> => {
      // Taken: a run that outlived its claim finds another run's "done" here
      // and writes nothing.
      if (!(await claims.claim(acceptedKey(claimKey), EVENT_CLAIM_SECONDS)))
        throw new CommandTakenError();
      run.markedDone = true;
    };
  }
  try {
    if (isMessage) {
      await handleMessage(env, (payload.event ?? payload) as FeishuEvent, run);
    } else if (eventType === "card.action.trigger") {
      await handleCardAction(env, payload, run);
    }
  } catch (err) {
    // Finished by another run meanwhile: nothing to give back or repeat.
    if (err instanceof CommandTakenError) return new Response("ok", { status: 200 });
    log.error({ err }, "Feishu webhook handling failed");
    // Failed before reaching GitHub: give the event back and answer with an
    // error, so Feishu's retry runs it. After GitHub acted it stays claimed.
    if (!run.acted) {
      if (eventId) {
        // An early "done" this run wrote (right before a write GitHub
        // refused) too — never one another run wrote meanwhile.
        if (run.markedDone) {
          await claims.release(acceptedKey(claimKey)).catch(() => undefined);
        }
        await claims.release(claimKey).catch(() => undefined);
      }
      return new Response("temporarily unavailable", { status: 503 });
    }
  }

  // A "done" already written before the GitHub write needs no second write.
  if (eventId && !run.markedDone) {
    // Best-effort: unconfirmed, the claim still holds off retries until it expires.
    await confirmClaim(claims, claimKey, EVENT_CLAIM_SECONDS).catch((err: unknown) =>
      log.warn({ err, eventId }, "Failed to confirm a Feishu event"),
    );
  }
  return new Response("ok", { status: 200 });
}

export { FEISHU_API };
