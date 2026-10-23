import { Octokit } from "octokit";
import { saveToken, getToken } from "./store";

export function getOAuthURL(clientId: string, state: string): string {
  // `read:org` lets the install flow check organization admin rights.
  return `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=${encodeURIComponent("repo read:org")}&state=${state}`;
}

function b64url(buf: ArrayBuffer | string): string {
  const bytes = typeof buf === "string" ? new TextEncoder().encode(buf) : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pemToBinary(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** GitHub App JWT (RS256, PKCS#8 PEM key), valid ~10 minutes. */
export async function createAppJwt(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }));
  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBinary(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

export interface InstallationAccount {
  login: string;
  id: number;
  /** "User" or "Organization". */
  type: string;
}

const API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "WebHooker",
};

/**
 * Look up the account (org/user) that owns a GitHub App installation, using
 * an App JWT. Returns null when the App credentials are missing or the lookup
 * fails.
 */
export async function getInstallationDetails(
  appId: string,
  privateKey: string,
  installationId: number,
): Promise<InstallationAccount | null> {
  if (!appId || !privateKey) return null;
  try {
    const jwt = await createAppJwt(appId, privateKey);
    const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
      headers: { ...API_HEADERS, Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      account?: { login?: string; id?: number; type?: string };
    };
    if (!data.account?.login) return null;
    // An account without an id can still be named, but never matches a user.
    return { login: data.account.login, id: data.account.id ?? -1, type: data.account.type ?? "" };
  } catch {
    return null;
  }
}

/** The login of the account owning an installation (null when unknown). */
export async function getInstallationAccount(
  appId: string,
  privateKey: string,
  installationId: number,
): Promise<string | null> {
  return (await getInstallationDetails(appId, privateKey, installationId))?.login ?? null;
}

/**
 * Whether a GitHub user may administer an App installation. The Setup URL's
 * `installation_id` is attacker-controlled, so binding it to a group requires
 * proof from the user's own token: the user is the installation's account, or
 * an active admin of its organization. Merely having access to it (being
 * listed in `/user/installations` as a collaborator) is not enough.
 */
export async function userManagesInstallation(
  token: string,
  userId: string,
  _installationId: number,
  account: InstallationAccount | null,
): Promise<boolean> {
  const headers = { ...API_HEADERS, Authorization: `Bearer ${token}` };
  try {
    if (!account) return false;
    if (account.type === "User") return String(account.id) === userId;
    const res = await fetch(
      `https://api.github.com/user/memberships/orgs/${encodeURIComponent(account.login)}`,
      { headers },
    );
    if (!res.ok) return false;
    const membership = (await res.json()) as { state?: string; role?: string };
    return membership.state === "active" && membership.role === "admin";
  } catch {
    return false;
  }
}

export async function handleOAuthCallback(
  clientId: string,
  clientSecret: string,
  code: string,
  _state: string,
  kv: KVNamespace,
): Promise<{ userId: string; login: string } | null> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
  };

  if (!data.access_token) return null;

  const octokit = new Octokit({ auth: data.access_token });
  const { data: user } = await octokit.rest.users.getAuthenticated();

  await saveToken(kv, user.id.toString(), data.access_token, 3600 * 10);

  return { userId: user.id.toString(), login: user.login };
}

export async function getUserOctokit(userId: string, kv: KVNamespace): Promise<Octokit | null> {
  const token = await getToken(kv, userId);
  if (!token) return null;
  return new Octokit({ auth: token });
}

/**
 * Map an Octokit REST error to a stable, translatable code the caller can
 * turn into a user-facing message.
 */
function mapGitHubError(err: unknown): Error {
  const status = (err as { status?: number })?.status;
  if (status === 401) return new Error("GITHUB_TOKEN_EXPIRED");
  if (status === 403) return new Error("GITHUB_FORBIDDEN");
  if (status === 404) return new Error("GITHUB_NOT_FOUND");
  return err instanceof Error ? err : new Error(String(err));
}

async function requireOctokit(kv: KVNamespace, githubUserId: string): Promise<Octokit> {
  const octokit = await getUserOctokit(githubUserId, kv);
  if (!octokit) throw new Error("GITHUB_TOKEN_EXPIRED");
  return octokit;
}

/**
 * Post an issue/PR comment AS the given GitHub user (their OAuth token),
 * so the comment shows up under their own identity instead of the bot.
 */
export async function commentAsUser(
  kv: KVNamespace,
  githubUserId: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<{ htmlUrl: string; login: string }> {
  const octokit = await requireOctokit(kv, githubUserId);
  try {
    const { data: me } = await octokit.rest.users.getAuthenticated();
    const res = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return { htmlUrl: res.data.html_url, login: me.login };
  } catch (err) {
    throw mapGitHubError(err);
  }
}

/** Fetch a single issue comment's current body (used to prefill the edit modal). */
export async function getCommentAsUser(
  kv: KVNamespace,
  githubUserId: string,
  owner: string,
  repo: string,
  commentId: number,
): Promise<{ body: string; login: string }> {
  const octokit = await requireOctokit(kv, githubUserId);
  try {
    const res = await octokit.rest.issues.getComment({ owner, repo, comment_id: commentId });
    return { body: res.data.body ?? "", login: res.data.user?.login ?? "" };
  } catch (err) {
    throw mapGitHubError(err);
  }
}

/** Edit an existing issue/PR comment. GitHub enforces permission (403 if not allowed). */
export async function editCommentAsUser(
  kv: KVNamespace,
  githubUserId: string,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<{ htmlUrl: string }> {
  const octokit = await requireOctokit(kv, githubUserId);
  try {
    const res = await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body,
    });
    return { htmlUrl: res.data.html_url };
  } catch (err) {
    throw mapGitHubError(err);
  }
}

/** Delete an existing issue/PR comment. GitHub enforces permission (403 if not allowed). */
export async function deleteCommentAsUser(
  kv: KVNamespace,
  githubUserId: string,
  owner: string,
  repo: string,
  commentId: number,
): Promise<void> {
  const octokit = await requireOctokit(kv, githubUserId);
  try {
    await octokit.rest.issues.deleteComment({ owner, repo, comment_id: commentId });
  } catch (err) {
    throw mapGitHubError(err);
  }
}

/** Merge a pull request as the linked GitHub user. GitHub enforces permission (403 if not allowed). */
export async function mergePullRequestAsUser(
  kv: KVNamespace,
  githubUserId: string,
  owner: string,
  repo: string,
  pullNumber: number,
  method: "merge" | "squash" | "rebase" = "squash",
): Promise<void> {
  const octokit = await requireOctokit(kv, githubUserId);
  try {
    await octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: pullNumber,
      merge_method: method,
    });
  } catch (err) {
    throw mapGitHubError(err);
  }
}

/** Close a pull request as the linked GitHub user. GitHub enforces permission (403 if not allowed). */
export async function closePullRequestAsUser(
  kv: KVNamespace,
  githubUserId: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<void> {
  const octokit = await requireOctokit(kv, githubUserId);
  try {
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: pullNumber,
      state: "closed",
    });
  } catch (err) {
    throw mapGitHubError(err);
  }
}
