import type { H3Event } from "h3";
import {
  appendResponseHeader,
  createError,
  getHeader,
  getQuery,
  readBody,
  sendRedirect,
  setResponseStatus,
} from "h3";
import {
  getOAuthURL,
  handleOAuthCallback as handleGithubOAuthCallback,
  getInstallationDetails,
  userManagesInstallation,
} from "../github/oauth";
import { getToken, linkStatement, removeToken } from "../github/store";
import {
  createAdminSession,
  adminCookie,
  getAdminSession,
  isAdminUser,
  authLogin,
  claimLogin,
} from "./session";
import {
  loadGroups,
  createGroup,
  updateGroup,
  resolveScope,
  hasAnyAccess,
  ensureInstallationGroup,
  normalizeGroupMembers,
  roleAt,
  bindMemberIds,
  memberRole,
} from "./groups";
import { log } from "../lib/log";
import { idempotencyStore, recordStatement, unrecordedGuard } from "../lib/idempotency";
import { clientIp } from "./auth";
import { recordAudit } from "../lib/audit";
import { sendMessage } from "../drivers/telegram/rest";
import { getTenantAccessToken, sendText as sendFeishuText } from "../drivers/feishu/rest";
import { cfEnv } from "../cf";
import { initConfigStore } from "../config";
import type { Env, Group } from "../types";

/** Which chat account a bot `/gh login` link binds, with a name to show. */
interface PendingLink {
  platform: "discord" | "telegram" | "feishu";
  userId: string;
  /** Display name of the chat account, shown on the confirmation page. */
  name?: string;
  /** Chat to notify once the link is confirmed (Telegram / Feishu). */
  chatId?: string;
}

interface PendingState {
  redirectTo: string;
  expiresAt: number;
  /** Set when the flow was started by a bot command instead of a browser login. */
  link?: PendingLink;
  // Legacy shapes of `link`, still accepted for states created before it.
  discordUserId?: string;
  telegramUserId?: string;
  telegramChatId?: string;
  feishuUserId?: string;
  feishuChatId?: string;
}

/** A confirmed OAuth identity waiting for the user to approve a bot link. */
interface LinkConfirmation extends PendingLink {
  githubUserId: string;
  login: string;
}

const STATE_COOKIE = "wh_oauth_state";
const STATE_TTL = 600;
const LINK_TTL = 600;

function stateCookie(state: string): string {
  return `${STATE_COOKIE}=${state}; Path=/auth/github; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL}`;
}

function clearStateCookie(): string {
  return `${STATE_COOKIE}=; Path=/auth/github; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx !== -1 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

function pendingLink(pending: PendingState): PendingLink | null {
  if (pending.link) return pending.link;
  if (pending.discordUserId) return { platform: "discord", userId: pending.discordUserId };
  if (pending.telegramUserId) {
    return {
      platform: "telegram",
      userId: pending.telegramUserId,
      chatId: pending.telegramChatId,
    };
  }
  if (pending.feishuUserId) {
    return { platform: "feishu", userId: pending.feishuUserId, chatId: pending.feishuChatId };
  }
  return null;
}

const PAGE_STYLE =
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f6f7f9;color:#1f2328}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 32px;width:min(480px,92vw);box-sizing:border-box;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)}.ok{color:#16a34a;font-size:40px}h1{font-size:18px;margin:12px 0 6px}p{color:#57606a;font-size:14px;margin:6px 0}b{color:#1f2328}.btn{display:inline-block;margin-top:16px;background:#1f2328;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:14px;cursor:pointer}.btn:hover{background:#32383f}.warn{color:#b45309;font-size:13px}";

const PLATFORM_NAMES: Record<PendingLink["platform"], string> = {
  discord: "Discord",
  telegram: "Telegram",
  feishu: "飞书",
};

function linkedPage(login: string, platform: PendingLink["platform"]): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>绑定成功</title><style>${PAGE_STYLE}</style></head><body><div class="card"><div class="ok">✓</div><h1>GitHub 账号已绑定</h1><p>已连接为 <b>@${escapeHtml(login)}</b>，现在可以回到 ${PLATFORM_NAMES[platform]} 用 GitHub 评论了。</p></div></body></html>`;
}

/**
 * Asks the GitHub user to approve the binding before it happens: a `/gh
 * login` link may have been forwarded, so the page names both accounts and
 * nothing is linked until this user confirms.
 */
function confirmLinkPage(nonce: string, link: LinkConfirmation): string {
  const chatAccount = link.name
    ? `${escapeHtml(link.name)}（ID ${escapeHtml(link.userId)}）`
    : `ID ${escapeHtml(link.userId)}`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>确认绑定</title><style>${PAGE_STYLE}</style></head><body><div class="card"><h1>确认绑定 GitHub 账号</h1><p>将 GitHub 账号 <b>@${escapeHtml(link.login)}</b></p><p>绑定到 ${PLATFORM_NAMES[link.platform]} 账号 <b>${chatAccount}</b>？</p><p class="warn">绑定后，该 ${PLATFORM_NAMES[link.platform]} 账号可以用你的 GitHub 身份评论、合并或关闭 PR。若这个链接不是你本人发起的，请直接关闭本页。</p><form method="post" action="/auth/github/link"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}"><button class="btn" type="submit">确认绑定</button></form></div></body></html>`;
}

function messagePage(title: string, text: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></div></body></html>`;
}

function generateRandomHex(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function safeRedirectPath(value: string | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  if (/^\/\\/.test(value)) return "/";
  // Browsers drop tabs and line breaks from URLs (`/\t/evil.example` becomes
  // `//evil.example`): refused, and the path is checked as a browser reads
  // it — it must stay on this origin, and only that normalized path is used.
  if (/[\u0000-\u001f\u007f]/.test(value)) return "/";
  const base = "https://webhooker.invalid";
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return "/";
  }
  // Dot segments can normalize into `//host` (`/a/..//evil.example`): read
  // again, that would leave the site.
  if (url.origin !== base || url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function selfSignupEnabled(env: Env): boolean {
  const flag = (env.ALLOW_SELF_SIGNUP ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

/**
 * Opt-in self service: users without any group access get a personal group
 * they own, so they can configure their own routing without a super admin.
 * The group id is deterministic (`u-{userId}`), so it is created at most once.
 * Personal groups are isolated: only their own `/webhook/{groupId}` ingress
 * dispatches to them, never the operator's global endpoint.
 */
async function ensurePersonalGroup(env: Env, userId: string, login: string): Promise<boolean> {
  if (!selfSignupEnabled(env)) return false;
  const gid = `u-${userId}`;
  const personal: Group = {
    id: gid,
    name: `@${login}`,
    members: [{ login, role: "owner", userId }],
    adminIds: [login],
    isolated: true,
  };
  if (!(await createGroup(env.KV, personal))) return true;
  // Filed under the instance the server gave the group (it follows renames).
  const stored = (await loadGroups(env.KV, { fresh: true })).find((g) => g.id === gid);
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: userId,
    actorLogin: login,
    action: "group.create",
    targetType: "group",
    targetId: gid,
    groupId: gid,
    groupInstance: stored?.instance,
    detail: { auto: true },
  });
  return true;
}

/**
 * Post-install choice page: pick which group the installation binds to.
 * Options are the groups the signed-in user owns (role `owner`), plus a
 * default "create a new group" choice.
 */
function installPage(opts: {
  installationId: number;
  accountLogin: string;
  owned: Group[];
}): string {
  const { installationId, accountLogin, owned } = opts;
  const accountLine = accountLogin
    ? `<p>账号：<b>${escapeHtml(accountLogin)}</b>（安装 ID <code>${installationId}</code>）</p>`
    : `<p>安装 ID：<code>${installationId}</code></p>`;
  const ownedOptions = owned
    .map(
      (g) =>
        `<label class="opt"><input type="radio" name="group" value="${escapeHtml(g.id)}"><span><b>${escapeHtml(g.name)}</b> <code>${escapeHtml(g.id)}</code></span></label>`,
    )
    .join("");
  const ownedNote = owned.length
    ? '<p class="hint">也可以选择绑定到你有 owner 权限的已有分组：</p>'
    : "";
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>安装 GitHub App</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f6f7f9;color:#1f2328}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 32px;width:min(480px,92vw);box-shadow:0 1px 3px rgba(0,0,0,.06)}h1{font-size:17px;margin:0 0 4px}p{color:#57606a;font-size:13.5px;margin:6px 0}code{background:#f0f1f3;border-radius:4px;padding:1px 5px;font-size:12.5px}.opt{display:flex;align-items:flex-start;gap:8px;padding:9px 10px;border:1px solid #e5e7eb;border-radius:8px;margin-top:8px;cursor:pointer}.opt:hover{background:#fafbfc}.hint{font-size:12.5px;color:#8b949e;margin-top:10px}.btn{display:inline-block;margin-top:14px;background:#1f2328;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:14px;cursor:pointer}.btn:hover{background:#32383f}.skip{margin-left:12px;color:#8b949e;font-size:13px;text-decoration:none}</style></head><body><div class="card"><h1>GitHub App 安装成功</h1>${accountLine}<p>将安装绑定到哪个分组？建议直接创建新分组，之后可以在控制台添加路由与成员。</p><form method="post" action="/auth/github/install/bind"><input type="hidden" name="installation_id" value="${installationId}"><label class="opt"><input type="radio" name="group" value="" checked><span><b>创建新分组</b> <code>inst-${installationId}</code></span></label>${ownedNote}${ownedOptions}<button class="btn" type="submit">确定</button></form></div></body></html>`;
}

/**
 * Whether the signed-in user may bind this installation. Super admins (the
 * operator) may; everyone else must prove access with their own GitHub token,
 * because the Setup URL's `installation_id` can be set to anything.
 */
async function canManageInstallation(
  env: Env,
  session: { userId: string; login: string },
  installationId: number,
): Promise<{ ok: boolean; accountLogin: string }> {
  const account = await getInstallationDetails(
    env.GITHUB_APP_ID ?? "",
    env.GITHUB_PRIVATE_KEY ?? "",
    installationId,
  );
  const accountLogin = account?.login ?? "";
  if (isAdminUser(env, session.userId, authLogin(session))) return { ok: true, accountLogin };
  const token = await getToken(env, session.userId);
  if (!token) return { ok: false, accountLogin };
  const ok = await userManagesInstallation(token, session.userId, installationId, account);
  return { ok, accountLogin };
}

/** GET /auth/github — start the OAuth flow. */
export async function handleOAuthStart(event: H3Event): Promise<void> {
  const env = cfEnv(event);
  initConfigStore(env);
  const query = getQuery(event);
  const redirectTo = safeRedirectPath(String(query["redirect"] ?? ""));
  const state = generateRandomHex(16);
  const pending: PendingState = {
    redirectTo,
    expiresAt: Date.now() + STATE_TTL * 1000,
  };
  await env.KV.put(`state:${state}`, JSON.stringify(pending), { expirationTtl: STATE_TTL });
  // Binds the flow to this browser: the callback only signs in the browser
  // that started it (no login CSRF with a callback URL from another session).
  appendResponseHeader(event, "Set-Cookie", stateCookie(state));
  await sendRedirect(event, getOAuthURL(env.GITHUB_CLIENT_ID ?? "", state));
}

/** GET /auth/github/install — post-install choice page. */
export async function handleInstallPage(event: H3Event): Promise<string | void> {
  const env = cfEnv(event);
  initConfigStore(env);
  const query = getQuery(event);
  const rawId = String(query["installation_id"] ?? "");
  const installationId = Number(rawId);
  if (!rawId || !Number.isInteger(installationId) || installationId <= 0) {
    throw createError({ statusCode: 400, statusMessage: "Missing installation_id" });
  }
  const session = await getAdminSession(env.KV, getHeader(event, "cookie"), env.DB);
  if (!session) {
    const target = `/auth/github/install?installation_id=${installationId}`;
    await sendRedirect(event, `/auth/github?redirect=${encodeURIComponent(target)}`);
    return;
  }
  const access = await canManageInstallation(env, session, installationId);
  if (!access.ok) {
    await sendRedirect(event, "/admin?error=install-forbidden");
    return;
  }
  const groups = await loadGroups(env.KV, { fresh: true });
  const scope = resolveScope(env, groups, session.userId, authLogin(session));
  const owned = groups.filter((g) => roleAt(scope, g.id) === "owner");
  return installPage({ installationId, accountLogin: access.accountLogin, owned });
}

/** POST /auth/github/install/bind — provision the chosen binding. */
export async function handleInstallBind(event: H3Event): Promise<void> {
  const env = cfEnv(event);
  initConfigStore(env);
  const session = await getAdminSession(env.KV, getHeader(event, "cookie"), env.DB);
  if (!session) {
    await sendRedirect(event, "/admin?error=forbidden");
    return;
  }
  const body = (await readBody(event).catch(() => ({}))) as Record<string, string | undefined>;
  const rawId = String(body["installation_id"] ?? "");
  const installationId = Number(rawId);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw createError({ statusCode: 400, statusMessage: "Missing installation_id" });
  }
  const access = await canManageInstallation(env, session, installationId);
  if (!access.ok) {
    await sendRedirect(event, "/admin?error=install-forbidden");
    return;
  }
  const accountLogin = access.accountLogin;
  const chosenGroupId = String(body["group"] ?? "").trim();
  const groups = await loadGroups(env.KV, { fresh: true });
  const scope = resolveScope(env, groups, session.userId, authLogin(session));

  if (chosenGroupId) {
    // Binding to an existing group requires owner permission on it.
    if (!groups.some((g) => g.id === chosenGroupId) || roleAt(scope, chosenGroupId) !== "owner") {
      await sendRedirect(event, "/admin?error=forbidden");
      return;
    }
    // Still an owner of the group as it is now (the write is a CAS on it).
    let revoked = false;
    const bound = await updateGroup(env.KV, chosenGroupId, (g) => {
      const owner =
        isAdminUser(env, session.userId, authLogin(session)) ||
        memberRole(g, session.userId, authLogin(session)) === "owner";
      if (!owner) {
        revoked = true;
        return null;
      }
      return { ...g, installationId };
    });
    if (revoked) {
      await sendRedirect(event, "/admin?error=forbidden");
      return;
    }
    if (!bound) {
      await sendRedirect(event, "/admin?error=install");
      return;
    }
    await recordAudit(env.DB, {
      ts: Date.now(),
      actorId: session.userId,
      actorLogin: session.login,
      action: "installation.bind",
      targetType: "group",
      targetId: chosenGroupId,
      groupId: chosenGroupId,
      groupInstance: bound.instance,
      detail: { installationId },
      ip: clientIp(event),
    });
    await sendRedirect(event, "/admin?install=ok");
    return;
  }

  // Default: auto-create a dedicated inst-{id} group.
  const group = await ensureInstallationGroup(env.KV, installationId, accountLogin, env.DB);
  if (!group) {
    await sendRedirect(event, "/admin?error=install");
    return;
  }
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: session.userId,
    actorLogin: session.login,
    action: "installation.created",
    targetType: "group",
    targetId: group.id,
    groupId: group.id,
    groupInstance: group.instance,
    detail: { source: "setup_url", account: accountLogin || undefined },
    ip: clientIp(event),
  });

  // Self-service SaaS: the verified installer manages the group created for
  // their installation — only the dedicated `inst-{id}` group, only while it is
  // still bound to this installation, and only while nobody manages it yet.
  // Any other group (an org group bound via `owners`, an operator group, one
  // claimed earlier) is never handed to a new owner this way.
  if (selfSignupEnabled(env) && group.id === `inst-${installationId}`) {
    let added = false;
    await updateGroup(env.KV, group.id, (g) => {
      const members = normalizeGroupMembers(g);
      if (g.installationId !== installationId || members.length > 0) return null;
      added = true;
      return {
        ...g,
        members: [{ login: session.login, role: "owner", userId: session.userId }],
        adminIds: [session.login],
      };
    });
    if (added) {
      await recordAudit(env.DB, {
        ts: Date.now(),
        actorId: session.userId,
        actorLogin: session.login,
        action: "group.member.add",
        targetType: "group",
        targetId: group.id,
        groupId: group.id,
        groupInstance: group.instance,
        detail: { login: session.login, role: "owner", auto: true },
        ip: clientIp(event),
      });
    }
  }

  await sendRedirect(event, "/admin?install=ok");
}

/** GET /auth/github/callback — OAuth callback. */
export async function handleOAuthCallback(event: H3Event): Promise<unknown> {
  const env = cfEnv(event);
  initConfigStore(env);
  const query = getQuery(event);
  const code = String(query["code"] ?? "");
  const state = String(query["state"] ?? "");
  if (!code || !state) {
    setResponseStatus(event, 400);
    return { error: "Missing code or state" };
  }

  const raw = await env.KV.get(`state:${state}`, "json");
  if (!raw) {
    setResponseStatus(event, 400);
    return { error: "Invalid or expired state" };
  }
  const pending = raw as PendingState;
  await env.KV.delete(`state:${state}`);
  if (Date.now() > pending.expiresAt) {
    setResponseStatus(event, 400);
    return { error: "Invalid or expired state" };
  }
  const link = pendingLink(pending);
  // A browser sign-in must come back to the browser that started it. Bot
  // links are opened elsewhere by design; they are confirmed explicitly below.
  if (!link && cookieValue(getHeader(event, "cookie"), STATE_COOKIE) !== state) {
    setResponseStatus(event, 400);
    return { error: "Invalid or expired state" };
  }
  if (!link) appendResponseHeader(event, "Set-Cookie", clearStateCookie());

  const result = await handleGithubOAuthCallback(
    env.GITHUB_CLIENT_ID ?? "",
    env.GITHUB_CLIENT_SECRET ?? "",
    code,
    state,
    env.KV,
    env.DB,
  );
  if (!result) {
    setResponseStatus(event, 400);
    return { error: "OAuth failed" };
  }

  // Bot account linking: never bind on the callback itself. The person who
  // authorized GitHub confirms which chat account gets their identity.
  if (link) {
    const nonce = generateRandomHex(16);
    const confirmation: LinkConfirmation = {
      ...link,
      githubUserId: result.userId,
      login: result.login,
    };
    await env.KV.put(`link:${nonce}`, JSON.stringify(confirmation), { expirationTtl: LINK_TTL });
    return confirmLinkPage(nonce, confirmation);
  }

  const isBrowser = (getHeader(event, "accept") ?? "").includes("text/html");
  if (isBrowser) {
    // Invite accept flow: the redirect target is the invite page, which
    // processes the token after the session exists. Skip the access gate so
    // non-members can get in and accept.
    const isInviteFlow =
      pending.redirectTo.startsWith("/admin/invite") ||
      pending.redirectTo.startsWith("/admin/invite?");

    let groups = await loadGroups(env.KV, { fresh: true });
    // A login first seen with another account grants nothing by name.
    const trusted = await claimLogin(env.KV, result.userId, result.login);
    const name = trusted ? result.login : "";
    let scope = resolveScope(env, groups, result.userId, name);

    if (!hasAnyAccess(scope) && !isInviteFlow) {
      const created = await ensurePersonalGroup(env, result.userId, result.login);
      if (created) {
        groups = await loadGroups(env.KV, { fresh: true });
        scope = resolveScope(env, groups, result.userId, name);
      }
    }
    if (!hasAnyAccess(scope) && !isInviteFlow) {
      await sendRedirect(event, "/admin?error=forbidden");
      return;
    }

    // Tie the member entries naming this login to the account itself.
    if (trusted) {
      await bindMemberIds(env.KV, groups, result.userId, result.login).catch((err: unknown) =>
        log.warn({ err, userId: result.userId }, "Failed to bind member ids"),
      );
    }
    const sessionId = await createAdminSession(env.KV, result.userId, result.login, trusted);
    appendResponseHeader(event, "Set-Cookie", adminCookie(sessionId));
    await recordAudit(env.DB, {
      ts: Date.now(),
      actorId: result.userId,
      actorLogin: result.login,
      action: "session.login",
      ip: clientIp(event),
    });
    await sendRedirect(event, pending.redirectTo);
    return;
  }

  return {
    userId: result.userId,
    login: result.login,
    redirectTo: pending.redirectTo,
  };
}

/** POST /auth/github/link — the GitHub user approved a bot account link. */
export async function handleLinkConfirm(event: H3Event): Promise<string> {
  const env = cfEnv(event);
  const body = (await readBody(event).catch(() => ({}))) as Record<string, string | undefined>;
  const nonce = String(body["nonce"] ?? "");
  const raw = /^[0-9a-f]{32}$/.test(nonce) ? await env.KV.get(`link:${nonce}`, "json") : null;
  // One use, recorded in D1: a replayed confirmation (or a stale KV copy
  // elsewhere) can never restore a link that was undone or replaced since.
  const claims = idempotencyStore(env.DB, env.KV);
  const usedKey = `link-used:${nonce}`;
  const expired = (): string => {
    setResponseStatus(event, 400);
    return messagePage("链接已失效", "请回到聊天里重新发送 /gh login。");
  };
  if (!raw || (await claims.has(usedKey))) return expired();
  const link = raw as LinkConfirmation;
  const notice = `✅ GitHub 账号已绑定：@${link.login}。现在可以用 /gh comment 评论了。`;
  // The link and its one-use record commit in one transaction, refused once
  // the record exists: a replay can never restore a link undone or replaced
  // since — not even after a write whose answer was lost (the record then
  // tells it went through). A failure before the commit leaves the pending
  // link, so submitting it again works.
  try {
    await env.DB.batch([
      unrecordedGuard(env.DB, usedKey),
      recordStatement(env.DB, usedKey, LINK_TTL),
      linkStatement(env.DB, link.platform, link.userId, link.githubUserId),
    ]);
  } catch (err) {
    if (!(await claims.has(usedKey).catch(() => false))) throw err;
    // Recorded: committed here (its answer lost), or by a concurrent submit.
    if (/already recorded|malformed JSON/i.test(String(err))) return expired();
  }
  await env.KV.delete(`link:${nonce}`).catch(() => undefined);
  if (link.platform === "telegram") {
    if (link.chatId && env.TELEGRAM_TOKEN) {
      await sendMessage(env.TELEGRAM_TOKEN, link.chatId, escapeHtml(notice)).catch(() => undefined);
    }
  } else if (link.platform === "feishu") {
    if (link.chatId) {
      const tokenRes = await getTenantAccessToken(env);
      if (tokenRes.ok && tokenRes.token) {
        await sendFeishuText(tokenRes.token, link.chatId, notice).catch(() => undefined);
      }
    }
  }
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: link.githubUserId,
    actorLogin: link.login,
    action: "account.link",
    targetType: link.platform,
    targetId: link.userId,
    ip: clientIp(event),
  });
  return linkedPage(link.login, link.platform);
}

/** DELETE /auth/token/:userId — revoke a stored user token (own token, or any for super admins). */
export async function handleTokenDelete(event: H3Event, userId: string): Promise<unknown> {
  const env = cfEnv(event);
  const session = await getAdminSession(env.KV, getHeader(event, "cookie"), env.DB);
  if (!session) {
    setResponseStatus(event, 401);
    return { error: "Unauthorized" };
  }
  if (session.userId !== userId && !isAdminUser(env, session.userId, authLogin(session))) {
    setResponseStatus(event, 403);
    return { error: "Forbidden" };
  }
  await removeToken(env.KV, userId, env.DB);
  await recordAudit(env.DB, {
    ts: Date.now(),
    actorId: session.userId,
    actorLogin: session.login,
    action: "token.delete",
    targetType: "token",
    targetId: userId,
    ip: clientIp(event),
  });
  return { ok: true };
}
