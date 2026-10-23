import { createAppJwt } from "./oauth";
import { sharedFlight, type Flight } from "../lib/shared-flight";

export const GITHUB_API_VERSION = "2022-11-28";
/**
 * Longest an optional enrichment call (installation token, jobs, check runs)
 * may take, its body included: a hanging one must not hold up the delivery.
 */
export const ENRICH_TIMEOUT_MS = 10_000;
export const GITHUB_USER_AGENT = "WebHooker (https://github.com/Elysola/WebHooker)";

/**
 * A payload-supplied API URL (`jobs_url`, `check_runs_url`) parsed only when
 * it points at the GitHub REST API's repository endpoints. Anything else — a
 * forged payload aiming a token at its own server — yields null.
 */
export function githubApiUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.host !== "api.github.com") return null;
    if (!url.pathname.startsWith("/repos/") || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Mint a short-lived installation access token for a GitHub App installation.
 * Returns undefined when the App credentials are missing or the exchange
 * fails. Best-effort: callers must not depend on it.
 */
/**
 * Installation tokens this isolate holds (until shortly before they expire),
 * and exchanges in flight: one per installation, not one per event — each is
 * a subrequest plus a JWT signature.
 */
const installationTokens = new Map<string, { token: string; until: number }>();
const exchanging = new Map<string, Flight<string | undefined>>();
/**
 * Installations whose exchange just failed, until when: enrichment is
 * optional, so the events right after go without it instead of each signing
 * a JWT and asking GitHub again.
 */
const failedExchanges = new Map<string, number>();
const FAILED_EXCHANGE_MS = 60_000;

export async function getInstallationToken(
  appId: string | undefined,
  privateKey: string | undefined,
  installationId: number | undefined,
): Promise<string | undefined> {
  if (!appId || !privateKey || !installationId) return undefined;
  const key = `${appId}:${installationId}`;
  const held = installationTokens.get(key);
  if (held && Date.now() < held.until) return held.token;
  if ((failedExchanges.get(key) ?? 0) > Date.now()) return undefined;
  return sharedFlight(
    exchanging,
    key,
    async () => {
      const token = await exchangeInstallationToken(appId, privateKey, installationId);
      if (token) failedExchanges.delete(key);
      else {
        if (failedExchanges.size >= 1000) failedExchanges.clear();
        failedExchanges.set(key, Date.now() + FAILED_EXCHANGE_MS);
      }
      return token;
    },
    ENRICH_TIMEOUT_MS + 5_000,
  );
}

async function exchangeInstallationToken(
  appId: string,
  privateKey: string,
  installationId: number,
): Promise<string | undefined> {
  try {
    const jwt = await createAppJwt(appId, privateKey);
    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": GITHUB_USER_AGENT,
        },
      },
    );
    if (!res.ok) return undefined;
    const { token, expires_at } = (await res.json()) as { token?: string; expires_at?: string };
    if (!token) return undefined;
    const expires = Date.parse(expires_at ?? "");
    // Tokens last an hour; given back 5 minutes early (a request in flight
    // never carries one that just expired).
    const until = (Number.isFinite(expires) ? expires : Date.now() + 3600_000) - 5 * 60_000;
    if (until > Date.now()) installationTokens.set(`${appId}:${installationId}`, { token, until });
    return token;
  } catch {
    return undefined;
  }
}
