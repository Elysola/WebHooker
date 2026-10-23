import { log } from "../../lib/log";
import {
  getOAuthURL,
  commentAsUser,
  getCommentAsUser,
  editCommentAsUser,
  deleteCommentAsUser,
  mergePullRequestAsUser,
  closePullRequestAsUser,
} from "../../github/oauth";
import { getDiscordLink, removeDiscordLink } from "../../github/store";
import { idempotencyStore } from "../../lib/idempotency";
import type { Env } from "../../types";
import { MSG_CMD_ADD, MSG_CMD_EDIT, MSG_CMD_DEL } from "./commands";

const DISCORD_API = "https://discord.com/api/v10";

// Discord interaction protocol constants
const INTERACTION_TYPE = { PING: 1, COMMAND: 2, BUTTON: 3, MODAL_SUBMIT: 5 } as const;
const CALLBACK_TYPE = { PONG: 1, MESSAGE: 4, DEFERRED_MESSAGE: 5, MODAL: 9 } as const;
const COMMAND_TYPE = { CHAT_INPUT: 1, MESSAGE: 3 } as const;
const EPHEMERAL = 64;

// Modal custom_id encodings (delimiter '|' never appears in owner/repo).
const MODAL_ADD = "ghc|add|"; // ghc|add|owner|repo|issueNumber
const MODAL_EDIT = "ghc|edit|"; // ghc|edit|owner|repo|commentId (read for older modals)
/** ghc|ed|owner|repo|commentId|base: an edit that remembers the text it was opened on. */
const MODAL_EDIT_BASE = "ghc|ed|";
/**
 * ghc|m|{context id}: the context kept in KV instead — only when the custom
 * id would pass Discord's 100 characters (a long owner/repo). KV writes are
 * scarce (Workers Free), so the context travels in the custom id whenever
 * it fits.
 */
const MODAL_CTX = "ghc|m|";
const MAX_CUSTOM_ID = 100;
/** Hex characters of the comment hash an edit modal remembers. */
const BASE_HASH_LENGTH = 16;
const MODAL_CTX_TTL_SECONDS = 86400;

interface ModalContext {
  op: "add" | "edit";
  owner: string;
  repo: string;
  /** Issue/PR number (add) or comment id (edit). */
  ref: string;
  /** SHA-256 (hex, possibly shortened) of the comment as the edit modal showed it. */
  base?: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function modalCustomId(env: Env, context: ModalContext): Promise<string> {
  const inline =
    context.op === "add"
      ? `${MODAL_ADD}${context.owner}|${context.repo}|${context.ref}`
      : `${MODAL_EDIT_BASE}${context.owner}|${context.repo}|${context.ref}|${context.base ?? ""}`;
  if (inline.length <= MAX_CUSTOM_ID) return inline;
  const contextId = crypto.randomUUID().replace(/-/g, "");
  await env.KV.put(`discord-modal:${contextId}`, JSON.stringify(context), {
    expirationTtl: MODAL_CTX_TTL_SECONDS,
  });
  return `${MODAL_CTX}${contextId}`;
}

async function modalContext(env: Env, customId: string): Promise<ModalContext | null> {
  if (customId.startsWith(MODAL_CTX)) {
    return env.KV.get<ModalContext>(`discord-modal:${customId.slice(MODAL_CTX.length)}`, "json");
  }
  if (customId.startsWith(MODAL_EDIT_BASE)) {
    const rest = customId.slice(MODAL_EDIT_BASE.length);
    const cut = rest.lastIndexOf("|");
    const [owner, repo, ref] = splitThree(rest.slice(0, cut));
    const base = rest.slice(cut + 1);
    return cut > 0 && owner && repo && ref ? { op: "edit", owner, repo, ref, base } : null;
  }
  for (const [prefix, op] of [
    [MODAL_ADD, "add"],
    [MODAL_EDIT, "edit"],
  ] as const) {
    if (!customId.startsWith(prefix)) continue;
    const [owner, repo, ref] = splitThree(customId.slice(prefix.length));
    return owner && repo && ref ? { op, owner, repo, ref } : null;
  }
  return null;
}

// PR notification button custom_id encodings.
const BTN_MERGE = "ghpr|merge|"; // ghpr|merge|owner|repo|pullNumber
const BTN_CLOSE = "ghpr|close|"; // ghpr|close|owner|repo|pullNumber

// Comment link (has the comment id); check this BEFORE the plain issue regex.
// Both only accept github.com itself (not e.g. `evilgithub.com`): the actions
// run against the GitHub API.
const GITHUB_COMMENT_RE =
  /https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/\d+#issuecomment-(\d+)/;
const GITHUB_ISSUE_RE =
  /https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/;
/** Discord caps a text input's value (and max_length) at 4000 characters. */
const MAX_MODAL_TEXT = 4000;

/**
 * Split a pipe-delimited custom-id suffix into [owner, repo, number]. The
 * number is always the last segment (arbitrary-length owner/repo can contain
 * pipes on non-GitHub forges), so we split from the right.
 */
function splitThree(rest: string): [string, string, string] {
  const parts = rest.split("|");
  const number = parts.pop();
  const repo = parts.pop();
  const owner = parts.join("|");
  return [owner ?? "", repo ?? "", number ?? ""];
}

interface DiscordUser {
  id?: string;
  username?: string;
  global_name?: string | null;
}

interface Interaction {
  id: string;
  /** The application the interaction belongs to (follow-up webhooks use it). */
  application_id?: string;
  token: string;
  type: number;
  channel_id?: string;
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  /** The message a component (button) is attached to. */
  message?: { id?: string };
  data?: Record<string, unknown>;
}

const MAX_BODY_SIZE = 1024 * 1024;
const TIMESTAMP_TOLERANCE_SECONDS = 180;

function hexToBytes(hex: string): ArrayBuffer {
  const buffer = new ArrayBuffer(hex.length / 2);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return buffer;
}

/**
 * Verify an interaction's Ed25519 signature (X-Signature-Ed25519 over
 * timestamp + raw body, signed by the Discord application public key).
 */
export async function verifyDiscordSignature(
  publicKey: string,
  timestamp: string,
  signatureHex: string,
  rawBody: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexToBytes(signatureHex),
      new TextEncoder().encode(timestamp + rawBody),
    );
  } catch (err) {
    log.warn({ err: String(err) }, "Failed to verify Discord signature");
    return false;
  }
}

/** Handle a POST to the Discord Interactions Endpoint. */
export async function handleInteractionRequest(request: Request, env: Env): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_SIZE) {
    return new Response("Request too large", { status: 413 });
  }

  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) {
    log.warn(
      { hasSig: !!signature, hasTs: !!timestamp, hasKey: !!env.DISCORD_PUBLIC_KEY },
      "Discord interaction missing signature",
    );
    return new Response("Invalid signature", { status: 401 });
  }
  const ts = Number(timestamp);
  if (
    !Number.isFinite(ts) ||
    Math.abs(Math.floor(Date.now() / 1000) - ts) > TIMESTAMP_TOLERANCE_SECONDS
  ) {
    return new Response("Invalid signature", { status: 401 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_SIZE) {
    return new Response("Request too large", { status: 413 });
  }

  const valid = await verifyDiscordSignature(env.DISCORD_PUBLIC_KEY, timestamp, signature, rawBody);
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  let interaction: Interaction;
  try {
    interaction = JSON.parse(rawBody) as Interaction;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Discord's connection check.
  if (interaction.type === INTERACTION_TYPE.PING) {
    return new Response(JSON.stringify({ type: CALLBACK_TYPE.PONG }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Discord does not redeliver interactions, but a replayed request (same
  // signed body within the timestamp window) must not run its action twice.
  if (
    interaction.id &&
    !(await idempotencyStore(env.DB, env.KV).claim(`bot:discord:${interaction.id}`, 3600))
  ) {
    return new Response(null, { status: 202 });
  }

  // Handle the interaction via the callback webhook; respond 202 with no body
  // as required for interactions received over the HTTP endpoint.
  await handleInteraction(env, interaction).catch((err) =>
    log.error({ err: String(err) }, "Interaction handler failed"),
  );
  return new Response(null, { status: 202 });
}

async function handleInteraction(env: Env, interaction: Interaction): Promise<void> {
  const user = interaction.member?.user ?? interaction.user;
  const userId = user?.id ?? null;
  const id = interaction.id;
  const token = interaction.token;
  const applicationId = interaction.application_id ?? env.DISCORD_APPLICATION_ID ?? "";

  if (interaction.type === INTERACTION_TYPE.BUTTON) {
    const data = interaction.data as { custom_id?: string };
    return handleButton(
      env,
      id,
      token,
      applicationId,
      userId,
      interaction.channel_id,
      interaction.message?.id,
      data.custom_id,
    );
  }

  if (interaction.type === INTERACTION_TYPE.COMMAND) {
    const data = interaction.data as {
      name?: string;
      type?: number;
      target_id?: string;
      options?: Array<{
        name: string;
        options?: Array<{
          name: string;
          value?: string;
          options?: Array<{ name: string; value?: string }>;
        }>;
      }>;
      resolved?: {
        messages?: Record<string, { embeds?: Array<{ url?: string }>; content?: string }>;
      };
    };

    // Right-click (message context-menu) commands.
    if (data.type === COMMAND_TYPE.MESSAGE) {
      const op =
        data.name === MSG_CMD_ADD
          ? "add"
          : data.name === MSG_CMD_EDIT
            ? "edit"
            : data.name === MSG_CMD_DEL
              ? "del"
              : null;
      if (!op) return;
      const target = data.target_id ? data.resolved?.messages?.[data.target_id] : undefined;
      const source = target?.embeds?.[0]?.url ?? target?.content ?? "";
      return commentOp(env, id, token, applicationId, userId, op, source);
    }

    // Slash command /gh ...
    if (data.name === "gh" && data.type === COMMAND_TYPE.CHAT_INPUT) {
      const top = data.options?.[0];
      if (top?.name === "login") {
        return cmdLogin(env, id, token, userId, user?.global_name || user?.username);
      }
      if (top?.name === "logout") return cmdLogout(env, id, token, userId);
      if (top?.name === "comment") {
        const sub = top.options?.[0];
        const op =
          sub?.name === "add"
            ? "add"
            : sub?.name === "edit"
              ? "edit"
              : sub?.name === "del"
                ? "del"
                : null;
        if (!op) return;
        const link = sub?.options?.find((o) => o.name === "link")?.value ?? "";
        return commentOp(env, id, token, applicationId, userId, op, link);
      }
      return;
    }
    return;
  }

  if (interaction.type === INTERACTION_TYPE.MODAL_SUBMIT) {
    return modalSubmit(env, id, token, applicationId, userId, interaction.data);
  }
}

/** Respond to an interaction with an ephemeral text message. */
async function respond(env: Env, id: string, token: string, content: string): Promise<void> {
  await interactionCallback(env, id, token, {
    type: CALLBACK_TYPE.MESSAGE,
    data: { content, flags: EPHEMERAL },
  });
}

/** Answer an interaction; whether Discord accepted the answer. */
async function interactionCallback(
  env: Env,
  id: string,
  token: string,
  body: unknown,
): Promise<boolean> {
  const res = await fetch(`${DISCORD_API}/interactions/${id}/${token}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    log.warn({ status: res.status, err }, "Interaction callback failed");
  }
  return res.ok;
}

/**
 * Replace the deferred (ephemeral) response body with the final result. The
 * original response is edited through the application's follow-up webhook.
 */
async function updateOriginal(
  applicationId: string,
  token: string,
  content: string,
): Promise<void> {
  if (!applicationId) {
    log.warn("Cannot update interaction response: application id unknown");
    return;
  }
  const res = await fetch(`${DISCORD_API}/webhooks/${applicationId}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const err = await res.text();
    log.warn({ status: res.status, err }, "Failed to update interaction response");
  }
}

/**
 * Acknowledge first (deferred, ephemeral), then run the GitHub action and
 * show its outcome: Discord fails an interaction not answered within 3
 * seconds, and a slow GitHub call must not leave a done action looking failed
 * (the user would submit it again).
 */
async function deferThen(
  env: Env,
  id: string,
  token: string,
  applicationId: string,
  work: () => Promise<string>,
): Promise<void> {
  // Not acknowledged: Discord shows the interaction as failed, so acting on
  // GitHub now would leave a done action looking failed (and resubmitted).
  const acked = await interactionCallback(env, id, token, {
    type: CALLBACK_TYPE.DEFERRED_MESSAGE,
    data: { flags: EPHEMERAL },
  });
  if (!acked) return;
  let content: string;
  try {
    content = await work();
  } catch (err) {
    content = errText(err);
  }
  await updateOriginal(applicationId, token, content);
}

/**
 * PR notification buttons: merge or close the PR as the clicker's linked
 * GitHub account. The clicker must have run `/gh login` first.
 */
async function handleButton(
  env: Env,
  id: string,
  token: string,
  applicationId: string,
  userId: string | null,
  channelId: string | undefined,
  messageId: string | undefined,
  customId: string | undefined,
): Promise<void> {
  if (!userId) return respond(env, id, token, "无法识别你的 Discord 账号。");
  const githubUserId = await getDiscordLink(env.DB, userId);
  if (!githubUserId) {
    return respond(env, id, token, "你还没有绑定 GitHub 账号，请先使用 `/gh login`。");
  }

  let op: "merge" | "close";
  let rest: string;
  if (customId?.startsWith(BTN_MERGE)) {
    op = "merge";
    rest = customId.slice(BTN_MERGE.length);
  } else if (customId?.startsWith(BTN_CLOSE)) {
    op = "close";
    rest = customId.slice(BTN_CLOSE.length);
  } else {
    return;
  }

  const [owner, repo, number] = splitThree(rest);
  if (!owner || !repo || !number) return;

  // Acknowledge first (deferred, ephemeral) so the clicker sees a spinner
  // while the GitHub API call runs; unacknowledged, nothing is done.
  const acked = await interactionCallback(env, id, token, {
    type: CALLBACK_TYPE.DEFERRED_MESSAGE,
    data: { flags: EPHEMERAL },
  });
  if (!acked) return;

  try {
    if (op === "merge") {
      await mergePullRequestAsUser(env, githubUserId, owner, repo, Number(number));
    } else {
      await closePullRequestAsUser(env, githubUserId, owner, repo, Number(number));
    }
    // Remove the buttons from the notification so nobody double-clicks.
    if (channelId && messageId) {
      await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${env.DISCORD_TOKEN ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ components: [] }),
      }).catch((err) => log.warn({ err: String(err) }, "Failed to strip PR buttons"));
    }
    const label = op === "merge" ? "合并" : "关闭";
    await updateOriginal(applicationId, token, `✅ 已${label} PR ${owner}/${repo}#${number}`);
  } catch (err) {
    await updateOriginal(applicationId, token, errText(err));
  }
}

async function cmdLogin(
  env: Env,
  id: string,
  token: string,
  userId: string | null,
  name: string | undefined,
): Promise<void> {
  if (!userId) return respond(env, id, token, "无法识别你的 Discord 账号。");
  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId) return respond(env, id, token, "服务器未配置 GitHub OAuth（GITHUB_CLIENT_ID）。");

  const state = crypto.randomUUID().replace(/-/g, "");
  await env.KV.put(
    `state:${state}`,
    JSON.stringify({
      redirectTo: "/",
      link: { platform: "discord", userId, name },
      expiresAt: Date.now() + 600_000,
    }),
    { expirationTtl: 600 },
  );
  const url = getOAuthURL(clientId, state);
  await respond(
    env,
    id,
    token,
    `点击链接授权 GitHub，即可用**本人身份**评论（仅你可见，10 分钟内有效）：\n${url}`,
  );
}

async function cmdLogout(
  env: Env,
  id: string,
  token: string,
  userId: string | null,
): Promise<void> {
  if (!userId) return respond(env, id, token, "无法识别你的 Discord 账号。");
  await removeDiscordLink(env.DB, userId);
  await respond(env, id, token, "已解绑你的 GitHub 账号。");
}

/** Map a GitHub op error code to a user-facing (Chinese) message. */
function errText(err: unknown): string {
  const t = err instanceof Error ? err.message : String(err);
  if (t === "GITHUB_TOKEN_EXPIRED") return "GitHub 授权已过期或无效，请重新使用 `/gh login` 绑定。";
  if (t === "GITHUB_FORBIDDEN") return "GitHub 拒绝了此操作：你的账号没有权限修改/删除这条评论。";
  if (t === "GITHUB_NOT_FOUND") return "找不到目标（可能评论已被删除或仓库不可访问）。";
  return `操作失败：${t}`;
}

/**
 * Unified entry for add/edit/del, from either a slash command (source = link
 * option) or a right-click message command (source = notification embed url).
 */
async function commentOp(
  env: Env,
  id: string,
  token: string,
  applicationId: string,
  userId: string | null,
  op: "add" | "edit" | "del",
  source: string,
): Promise<void> {
  if (!userId) return respond(env, id, token, "无法识别你的 Discord 账号。");
  const githubUserId = await getDiscordLink(env.DB, userId);
  if (!githubUserId) {
    return respond(env, id, token, "你还没有绑定 GitHub 账号，请先使用 `/gh login`。");
  }

  if (op === "add") {
    const m = source.match(GITHUB_ISSUE_RE);
    if (!m)
      return respond(
        env,
        id,
        token,
        "找不到 issue / PR 链接（右键 issue/PR 通知，或用 link 传入链接）。",
      );
    return openCommentModal(
      env,
      id,
      token,
      await modalCustomId(env, { op: "add", owner: m[1]!, repo: m[2]!, ref: m[3]! }),
      `评论 ${m[1]}/${m[2]}#${m[3]}`,
    );
  }

  // edit / del both need a specific comment id.
  const m = source.match(GITHUB_COMMENT_RE);
  if (!m) {
    return respond(
      env,
      id,
      token,
      "找不到评论链接（需含 `#issuecomment-...`，请右键某条评论通知，或粘贴评论链接）。",
    );
  }
  const [, owner, repo, commentId] = m;

  if (op === "del") {
    return deferThen(env, id, token, applicationId, async () => {
      await deleteCommentAsUser(env, githubUserId, owner!, repo!, Number(commentId));
      return `已删除评论 ${owner}/${repo}#issuecomment-${commentId}。`;
    });
  }

  // edit: fetch current body to prefill the modal.
  let prefill = "";
  try {
    const { body } = await getCommentAsUser(env, githubUserId, owner!, repo!, Number(commentId));
    prefill = body;
  } catch (err) {
    return respond(env, id, token, errText(err));
  }
  // The modal can only hold part of a longer comment, and saving it would
  // replace the whole comment with that part: such comments are edited on GitHub.
  if (prefill.length > MAX_MODAL_TEXT) {
    return respond(
      env,
      id,
      token,
      `这条评论超过 ${MAX_MODAL_TEXT} 字，无法在 Discord 中完整编辑，请到 GitHub 上编辑：${m[0]}`,
    );
  }
  return openCommentModal(
    env,
    id,
    token,
    await modalCustomId(env, {
      op: "edit",
      owner: owner!,
      repo: repo!,
      ref: commentId!,
      base: (await sha256Hex(prefill)).slice(0, BASE_HASH_LENGTH),
    }),
    `编辑评论 #${commentId}`,
    prefill,
  );
}

/** Open a modal to collect/edit comment body. */
async function openCommentModal(
  env: Env,
  id: string,
  token: string,
  customId: string,
  title: string,
  prefill = "",
): Promise<void> {
  await interactionCallback(env, id, token, {
    type: CALLBACK_TYPE.MODAL,
    data: {
      custom_id: customId,
      title: title.slice(0, 45),
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "body",
              label: "评论内容",
              style: 2,
              required: true,
              max_length: MAX_MODAL_TEXT,
              value: prefill || undefined,
            },
          ],
        },
      ],
    },
  });
}

async function modalSubmit(
  env: Env,
  id: string,
  token: string,
  applicationId: string,
  userId: string | null,
  data: unknown,
): Promise<void> {
  const d = data as {
    custom_id?: string;
    components?: Array<{ components?: Array<{ custom_id?: string; value?: string }> }>;
  };
  const customId = d.custom_id;
  if (!userId || !customId) return;

  // Submitted as written (an indented first line is a Markdown code block):
  // blank only decides emptiness.
  const body = d.components?.[0]?.components?.find((c) => c.custom_id === "body")?.value ?? "";
  if (!body.trim()) return respond(env, id, token, "评论内容不能为空。");

  const githubUserId = await getDiscordLink(env.DB, userId);
  if (!githubUserId) {
    return respond(env, id, token, "你还没有绑定 GitHub 账号，请先使用 `/gh login`。");
  }

  const context = await modalContext(env, customId);
  if (!context) {
    return respond(env, id, token, "这个评论框已失效，请重新打开。");
  }
  const { owner, repo, ref } = context;

  if (context.op === "add") {
    return deferThen(env, id, token, applicationId, async () => {
      const { htmlUrl, login } = await commentAsUser(
        env,
        githubUserId,
        owner,
        repo,
        Number(ref),
        body,
      );
      return `已以 **@${login}** 身份评论：${htmlUrl}`;
    });
  }

  return deferThen(env, id, token, applicationId, async () => {
    // Changed on GitHub since the modal showed it: saving would silently
    // replace those changes (GitHub has no conditional update — this check
    // narrows the window to the moment between it and the save).
    if (context.base) {
      const { body: current } = await getCommentAsUser(env, githubUserId, owner, repo, Number(ref));
      if ((await sha256Hex(current)).slice(0, context.base.length) !== context.base) {
        return "这条评论在你打开编辑框后已被修改。为避免覆盖这些修改，请重新打开编辑框。";
      }
    }
    const { htmlUrl } = await editCommentAsUser(env, githubUserId, owner, repo, Number(ref), body);
    return `已更新评论：${htmlUrl}`;
  });
}
