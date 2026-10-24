import {
  getInstallationToken,
  githubApiUrl,
  ENRICH_TIMEOUT_MS,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
} from "./app-token";

export interface WorkflowJob {
  name?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string;
  completed_at?: string;
}

/**
 * Fetch the jobs of a workflow run from its `jobs_url`. The `workflow_run`
 * webhook payload only carries `jobs_url`, never the jobs themselves, so this
 * enrichment is required for the formatter's Jobs field.
 *
 * Uses an App installation token when the credentials are available (required
 * for private repos); otherwise falls back to an unauthenticated request,
 * which works for public repositories at a lower rate limit. Best-effort:
 * returns undefined on any failure.
 */
export async function getWorkflowRunJobs(
  jobsUrl: string | undefined,
  appId: string | undefined,
  privateKey: string | undefined,
  installationId: number | undefined,
): Promise<WorkflowJob[] | undefined> {
  const url = githubApiUrl(jobsUrl);
  if (!url) return undefined;
  try {
    const token = await getInstallationToken(appId, privateKey, installationId);
    url.searchParams.set("per_page", "100");
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": GITHUB_USER_AGENT,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    // No redirects: a token must never follow a response to another host.
    const res = await fetch(url.toString(), {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { jobs?: WorkflowJob[] };
    return data.jobs?.length ? data.jobs : undefined;
  } catch {
    return undefined;
  }
}
