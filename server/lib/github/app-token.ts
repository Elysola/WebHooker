import { createAppJwt } from "./oauth";

export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_USER_AGENT = "WebHooker (https://github.com/Elysola/WebHooker)";

/**
 * Mint a short-lived installation access token for a GitHub App installation.
 * Returns undefined when the App credentials are missing or the exchange
 * fails. Best-effort: callers must not depend on it.
 */
export async function getInstallationToken(
  appId: string | undefined,
  privateKey: string | undefined,
  installationId: number | undefined,
): Promise<string | undefined> {
  if (!appId || !privateKey || !installationId) return undefined;
  try {
    const jwt = await createAppJwt(appId, privateKey);
    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": GITHUB_USER_AGENT,
        },
      },
    );
    if (!res.ok) return undefined;
    const { token } = (await res.json()) as { token?: string };
    return token ?? undefined;
  } catch {
    return undefined;
  }
}
