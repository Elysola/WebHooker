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
import { getTelegramLink, unlinkAsCommand } from "../../github/store";
import { acceptedKey, claimOnce, confirmClaim, idempotencyStore } from "../../lib/idempotency";
import type { Env } from "../../types";
import { sendMessage } from "./rest";
import { telegramWebhookSecret } from "./secret";

// github.com itself only (never e.g. `evilgithub.com`): actions hit the GitHub API.
/** An update is held this long while its command runs (then a redelivery may take it). */
const COMMAND_CLAIM_SECONDS = 300;
/** Handled updates are remembered this long. */
const COMMAND_DONE_SECONDS = 86400;

const GITHUB_ISSUE_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/;
const GITHUB_PR_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;

interface TelegramMessage {
  message_id?: number;
  text?: string;
  from?: { id?: number; first_name?: string; username?: string };
  chat?: { id?: number; type?: string; title?: string };
  date?: number;
  message_thread_id?: number;
  entities?: Array<{ type?: string; url?: string; offset?: number; length?: number }>;
  reply_to_message?: TelegramMessage;
}

let knownBotUsername: { token: string; name: string } | null = null;

/** This bot's username (lower case), from `getMe`; remembered per isolate. */
async function botUsername(env: Env): Promise<string> {
  const token = env.TELEGRAM_TOKEN ?? "";
  if (knownBotUsername?.token === token) return knownBotUsername.name;
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => null)) as {
    result?: { username?: string };
  } | null;
  const name = data?.result?.username;
  // Unknown: thrown, so Telegram redelivers the update rather than the
  // command being dropped.
  if (!res.ok || !name) throw new Error(`Telegram getMe failed (HTTP ${res.status})`);
  knownBotUsername = { token, name: name.toLowerCase() };
  return knownBotUsername.name;
}

interface Target {
  owner: string;
  repo: string;
  number: number;
}

function chatIdOf(msg: TelegramMessage): string | null {
  return msg.chat?.id != null ? String(msg.chat.id) : null;
}

function userIdOf(msg: TelegramMessage): string | null {
  return msg.from?.id != null ? String(msg.from.id) : null;
}

/** Extract a GitHub issue/PR link from a message (entities text_link or raw text). */
function extractTarget(msg: TelegramMessage, prOnly = false): Target | null {
  const urls: string[] = [];
  for (const ent of msg.entities ?? []) {
    if (ent.type === "text_link" && ent.url) urls.push(ent.url);
  }
  if (msg.text) {
    for (const u of msg.text.match(/https?:\/\/github\.com\/[^\s]+/g) ?? []) urls.push(u);
  }
  for (const url of urls) {
    const re = prOnly ? GITHUB_PR_RE : GITHUB_ISSUE_RE;
    const m = url.match(re);
    if (m && m[1] && m[2] && m[3]) return { owner: m[1], repo: m[2], number: Number(m[3]) };
  }
  return null;
}

/**
 * Send a reply. One that could not be sent for now throws, so the update is
 * redelivered rather than confirmed unanswered (a login link never sent);
 * a refusal that a retry cannot change (e.g. the bot was blocked) is logged.
 */
async function reply(
  env: Env,
  chatId: string,
  topicId: string | undefined,
  text: string,
): Promise<void> {
  const result = await sendMessage(env.TELEGRAM_TOKEN ?? "", chatId, text, topicId);
  if (result.ok) return;
  log.warn({ chatId, err: result.error }, "Telegram reply failed");
  if (!result.status || result.status >= 500 || result.status === 429) {
    throw new Error(`Telegram reply failed: ${result.error ?? "unknown"}`);
  }
}

function errText(err: unknown): string {
  const t = err instanceof Error ? err.message : String(err);
  if (t === "GITHUB_TOKEN_EXPIRED") return "GitHub 授权已过期或无效，请重新使用 /gh login 绑定。";
  if (t === "GITHUB_FORBIDDEN") return "GitHub 拒绝了此操作：你的账号没有权限。";
  if (t === "GITHUB_NOT_FOUND") return "找不到目标（可能已删除或仓库不可访问）。";
  return `操作失败：${t}`;
}

async function cmdLogin(env: Env, msg: TelegramMessage): Promise<void> {
  const chatId = chatIdOf(msg);
  const telegramUserId = userIdOf(msg);
  if (!chatId || !telegramUserId) return;
  const topicId = msg.message_thread_id != null ? String(msg.message_thread_id) : undefined;

  // An authorization link posted in a group can be opened by anyone there;
  // binding happens in the private chat with the bot only.
  if (msg.chat?.type !== "private") {
    return reply(env, chatId, topicId, "请私聊机器人发送 /gh login 绑定 GitHub 账号。");
  }

  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId)
    return reply(env, chatId, topicId, "服务器未配置 GitHub OAuth（GITHUB_CLIENT_ID）。");

  const name = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name;
  const state = crypto.randomUUID().replace(/-/g, "");
  await env.KV.put(
    `state:${state}`,
    JSON.stringify({
      redirectTo: "/",
      link: { platform: "telegram", userId: telegramUserId, name, chatId },
      expiresAt: Date.now() + 600_000,
    }),
    { expirationTtl: 600 },
  );
  const url = getOAuthURL(clientId, state);
  await reply(
    env,
    chatId,
    topicId,
    `点击链接授权 GitHub，即可用<b>本人身份</b>评论（10 分钟内有效）：\n${url}`,
  );
}

async function cmdLogout(env: Env, msg: TelegramMessage, run: CommandRun): Promise<void> {
  const chatId = chatIdOf(msg);
  const telegramUserId = userIdOf(msg);
  if (!chatId || !telegramUserId) return;
  const topicId = msg.message_thread_id != null ? String(msg.message_thread_id) : undefined;
  await unlinkAsCommand(env, "telegram", telegramUserId, run.done);
  // Done from here: should the reply fail, a redelivery must not unlink again
  // (by then it could remove a link made since).
  run.acted = true;
  await reply(env, chatId, topicId, "已解绑你的 GitHub 账号。");
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

async function cmdComment(
  env: Env,
  msg: TelegramMessage,
  body: string,
  run: CommandRun,
): Promise<void> {
  const chatId = chatIdOf(msg);
  const telegramUserId = userIdOf(msg);
  if (!chatId || !telegramUserId) return;
  const topicId = msg.message_thread_id != null ? String(msg.message_thread_id) : undefined;

  const githubUserId = await getTelegramLink(env.DB, telegramUserId);
  if (!githubUserId) {
    return reply(env, chatId, topicId, "你还没有绑定 GitHub 账号，请先使用 /gh login。");
  }

  const source = msg.reply_to_message;
  const target = source ? extractTarget(source) : null;
  if (!target) {
    return reply(
      env,
      chatId,
      topicId,
      "找不到 issue / PR 链接，请在对应的 GitHub 通知消息上回复 /gh comment。",
    );
  }

  try {
    const { htmlUrl, login } = await commentAsUser(
      env,
      githubUserId,
      target.owner,
      target.repo,
      target.number,
      body,
      { beforeWrite: run.beforeWrite },
    );
    run.acted = true;
    await reply(env, chatId, topicId, `已以 **@${login}** 身份评论：${htmlUrl}`);
  } catch (err) {
    // Nothing reached GitHub yet: give the update back for a retry.
    if (err instanceof BeforeGitHubError) throw err;
    // Done, only its reply failed: the update must not run again.
    if (run.acted) throw err;
    // GitHub was called and may have acted (its answer lost): never run
    // again. A refusal did nothing: should its reply fail, the command is
    // given back and runs again.
    if (!githubRefused(err)) run.acted = true;
    await reply(env, chatId, topicId, errText(err));
  }
}

async function cmdMergeClose(
  env: Env,
  msg: TelegramMessage,
  op: "merge" | "close",
  run: CommandRun,
): Promise<void> {
  const chatId = chatIdOf(msg);
  const telegramUserId = userIdOf(msg);
  if (!chatId || !telegramUserId) return;
  const topicId = msg.message_thread_id != null ? String(msg.message_thread_id) : undefined;

  const githubUserId = await getTelegramLink(env.DB, telegramUserId);
  if (!githubUserId) {
    return reply(env, chatId, topicId, "你还没有绑定 GitHub 账号，请先使用 /gh login。");
  }

  const source = msg.reply_to_message;
  const target = source ? extractTarget(source, true) : null;
  if (!target) {
    return reply(
      env,
      chatId,
      topicId,
      "找不到 PR 链接，请在对应的 GitHub PR 通知消息上回复 /gh merge 或 /gh close。",
    );
  }

  try {
    if (op === "merge") {
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
    const label = op === "merge" ? "合并" : "关闭";
    await reply(
      env,
      chatId,
      topicId,
      `✅ 已${label} PR ${target.owner}/${target.repo}#${target.number}`,
    );
  } catch (err) {
    // Nothing reached GitHub yet: give the update back for a retry.
    if (err instanceof BeforeGitHubError) throw err;
    // Done, only its reply failed: the update must not run again.
    if (run.acted) throw err;
    // GitHub was called and may have acted (its answer lost): never run
    // again. A refusal did nothing: should its reply fail, the command is
    // given back and runs again.
    if (!githubRefused(err)) run.acted = true;
    await reply(env, chatId, topicId, errText(err));
  }
}

/** Register the Telegram webhook to point at this worker (called from cron). */
export async function syncTelegramWebhook(env: Env): Promise<void> {
  const token = env.TELEGRAM_TOKEN;
  if (!token) return;
  const baseUrl = env.BASE_URL;
  if (!baseUrl) return;
  // Always registered with a secret (explicit or derived from the bot token),
  // so the webhook endpoint can authenticate every call.
  const secret = await telegramWebhookSecret(env);
  const registration = {
    url: `${baseUrl.replace(/\/$/, "")}/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ["message"],
  };
  // Registered again only when the registration changed (or once a day, to
  // repair a webhook changed elsewhere): this runs every few minutes, and
  // each run would otherwise be a subrequest. One KV read per run; a write
  // only when it registers.
  const digest = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${token}|${JSON.stringify(registration)}`),
      ),
    ),
  ]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // One record per bot holding what it is registered with now: switching
  // A -> B -> A registers A again (a record per digest would still hold A's).
  const marker = `telegram:webhook:${token.split(":")[0]}`;
  if ((await env.KV.get(marker).catch(() => null)) === digest) return;

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(registration),
  });
  if (!res.ok) {
    const err = await res.text();
    log.error({ status: res.status, err }, "Failed to set Telegram webhook");
    return;
  }
  await env.KV.put(marker, digest, { expirationTtl: 86400 }).catch(() => undefined);
}

/** Handle a single Telegram update (message). Called from the webhook route. */
export async function handleTelegramUpdate(env: Env, update: unknown): Promise<void> {
  const message = (update as { message?: TelegramMessage })?.message;
  if (!message?.text) return;

  // Only leading space goes: a comment's trailing lines are its own.
  const text = message.text.replace(/^\s+/, "");
  // `/gh@BotName ...` is how group chats address one bot among several: run
  // it only when the name is this bot's.
  const m = text.match(/^\/gh(?:@(\w+))?(?:\s+|$)(.*)$/s);
  if (!m) return;
  if (m[1] && m[1].toLowerCase() !== (await botUsername(env))) return;

  // Telegram redelivers an update until the webhook answers 200; a command
  // that already ran (e.g. its reply failed afterwards) must not run again,
  // and one whose run is unconfirmed is retried later, never dropped.
  const updateId = (update as { update_id?: number }).update_id;
  const claims = idempotencyStore(env.DB, env.KV);
  // Update ids count per bot: the key names the bot (the id before the
  // token's ":", stable across token changes), so another bot's update with
  // the same number is never taken for this one.
  const botId = (env.TELEGRAM_TOKEN ?? "").split(":")[0] ?? "";
  const claimKey = `bot:telegram:${botId}:${updateId}`;
  if (updateId != null) {
    // Handled under the key used before bots were told apart (kept one day).
    if (await claims.has(acceptedKey(`bot:telegram:${updateId}`))) return;
    const state = await claimOnce(claims, claimKey, COMMAND_CLAIM_SECONDS);
    if (state === "done") return;
    if (state === "pending") throw new Error("Telegram update is already being processed");
  }

  const rest = (m[2] ?? "").replace(/^\s+/, "");
  const sub = rest.split(/\s/, 1)[0] ?? "";
  // The comment as written: line breaks and indentation kept (only the
  // separator after the subcommand goes — up to its first line break).
  const body = rest.slice(sub.length).replace(/^[ \t]*\r?\n?/, "");
  const run: CommandRun = { acted: false };
  // Done on record before GitHub is written to: should the confirmation
  // after it fail, a redelivery still never repeats the write.
  if (updateId != null) {
    run.done = { key: acceptedKey(claimKey), ttl: COMMAND_DONE_SECONDS };
    run.beforeWrite = async (): Promise<void> => {
      // Taken: a run that outlived its claim finds another run's "done" here
      // and writes nothing.
      if (!(await claims.claim(acceptedKey(claimKey), COMMAND_DONE_SECONDS)))
        throw new CommandTakenError();
      run.markedDone = true;
    };
  }

  try {
    await runCommand(env, message, sub, body, text, run);
  } catch (err) {
    // Finished by another run meanwhile: nothing to give back or repeat.
    if (err instanceof CommandTakenError) return;
    // Failed before reaching GitHub (e.g. a storage error) or refused by it:
    // give the update back (an early "done" too), so Telegram's redelivery
    // runs it. After GitHub may have acted, it is done for good — running
    // again would repeat the comment / merge.
    if (updateId != null) {
      if (run.acted) {
        // Done for good; a "done" written before the GitHub write needs no
        // second write.
        if (!run.markedDone) await confirmDone();
      } else {
        // Only a "done" this run wrote: one another run wrote while this one
        // outlived its claim stays.
        if (run.markedDone) {
          await claims.release(acceptedKey(claimKey)).catch(() => undefined);
        }
        await claims.release(claimKey).catch(() => undefined);
      }
    }
    throw err;
  }
  // A "done" already written before the GitHub write needs no second write.
  if (updateId != null && !run.markedDone) await confirmDone();

  /** Best-effort: unconfirmed, the claim still holds off redeliveries until it expires. */
  async function confirmDone(): Promise<void> {
    await confirmClaim(claims, claimKey, COMMAND_DONE_SECONDS).catch((err: unknown) =>
      log.warn({ err, updateId }, "Failed to confirm a Telegram update"),
    );
  }
}

async function runCommand(
  env: Env,
  message: TelegramMessage,
  sub: string | undefined,
  body: string,
  text: string,
  run: CommandRun,
): Promise<void> {
  switch (sub) {
    case "login":
      return cmdLogin(env, message);
    case "logout":
      return cmdLogout(env, message, run);
    case "comment":
      if (!body.trim()) {
        const chatId = chatIdOf(message);
        const topicId =
          message.message_thread_id != null ? String(message.message_thread_id) : undefined;
        if (chatId) await reply(env, chatId, topicId, "请附上评论内容：/gh comment 你的评论");
        return;
      }
      return cmdComment(env, message, body, run);
    case "merge":
      return cmdMergeClose(env, message, "merge", run);
    case "close":
      return cmdMergeClose(env, message, "close", run);
    default:
      log.info({ text }, "Unhandled /gh command from Telegram");
  }
}
