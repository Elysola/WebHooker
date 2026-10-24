import {
  getInstallationToken,
  githubApiUrl,
  ENRICH_TIMEOUT_MS,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
} from "./app-token";

const CLOUDFLARE_SLUG = "cloudflare-workers-and-pages";

/**
 * Resolve a check suite's build log URL. The `check_suite` webhook payload
 * carries no `details_url` of its own — only the underlying `check_run` does
 * (Cloudflare sets it to the build log page). For a failed suite we fetch the
 * suite's check runs via the GitHub API and return the first run's
 * `details_url`, preferring the Cloudflare run when present.
 *
 * Returns undefined when the App credentials are missing, the call fails, or
 * no run exposes a `details_url`. Best-effort: callers must not depend on it.
 */
export async function getCheckSuiteBuildLogUrl(
  checkRunsUrl: string | undefined,
  appId: string | undefined,
  privateKey: string | undefined,
  installationId: number | undefined,
): Promise<string | undefined> {
  const url = githubApiUrl(checkRunsUrl);
  if (!url || !appId || !privateKey || !installationId) return undefined;
  try {
    const token = await getInstallationToken(appId, privateKey, installationId);
    if (!token) return undefined;

    // No redirects: a token must never follow a response to another host.
    const runsRes = await fetch(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": GITHUB_USER_AGENT,
      },
    });
    if (!runsRes.ok) return undefined;
    const data = (await runsRes.json()) as {
      check_runs?: Array<{ details_url?: string; app?: { slug?: string } }>;
    };
    const runs = data.check_runs ?? [];
    const cloudflare = runs.find((r) => r.app?.slug === CLOUDFLARE_SLUG && r.details_url);
    const any = runs.find((r) => r.details_url);
    return (cloudflare ?? any)?.details_url;
  } catch {
    return undefined;
  }
}
