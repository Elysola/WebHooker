import type { H3Event } from "h3";
import { readBody, setResponseStatus } from "h3";
import { getUserOctokit } from "../github/oauth";
import { bearerUserId } from "./auth";
import { cfEnv } from "../cf";
import { log } from "../lib/log";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidId(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function readJsonBody(event: H3Event): Promise<Record<string, unknown> | null> {
  try {
    const body = await readBody(event);
    if (typeof body === "string") {
      try {
        return JSON.parse(body) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return (body ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function userOctokit(
  event: H3Event,
  userId: string,
): Promise<Awaited<ReturnType<typeof getUserOctokit>>> {
  return getUserOctokit(userId, cfEnv(event));
}

function fail(event: H3Event, status: number, error: string): Record<string, unknown> {
  setResponseStatus(event, status);
  return { error };
}

/** POST /api/comment */
export async function apiComment(event: H3Event): Promise<Record<string, unknown>> {
  const userId = await bearerUserId(event);
  const body = await readJsonBody(event);
  if (
    !body ||
    !isNonEmptyString(body.owner) ||
    !isNonEmptyString(body.repo) ||
    !isValidId(body.issueNumber) ||
    !isNonEmptyString(body.body)
  ) {
    return fail(event, 400, "Invalid request body");
  }
  const octokit = await userOctokit(event, userId);
  if (!octokit) return fail(event, 401, "Not authorized");
  try {
    await octokit.rest.issues.createComment({
      owner: body.owner,
      repo: body.repo,
      issue_number: body.issueNumber,
      body: body.body,
    });
  } catch (err) {
    log.error({ err }, "Failed to create comment");
    return fail(event, 500, "GitHub API error");
  }
  return { ok: true };
}

/** POST /api/merge */
export async function apiMerge(event: H3Event): Promise<Record<string, unknown>> {
  const userId = await bearerUserId(event);
  const body = await readJsonBody(event);
  if (
    !body ||
    !isNonEmptyString(body.owner) ||
    !isNonEmptyString(body.repo) ||
    !isValidId(body.pullNumber)
  ) {
    return fail(event, 400, "Invalid request body");
  }
  const method = body.method === undefined ? "squash" : body.method;
  if (method !== "merge" && method !== "squash" && method !== "rebase") {
    return fail(event, 400, "Invalid request body");
  }
  const octokit = await userOctokit(event, userId);
  if (!octokit) return fail(event, 401, "Not authorized");
  try {
    await octokit.rest.pulls.merge({
      owner: body.owner,
      repo: body.repo,
      pull_number: body.pullNumber,
      merge_method: method,
    });
  } catch (err) {
    log.error({ err }, "Failed to merge pull request");
    return fail(event, 500, "GitHub API error");
  }
  return { ok: true };
}

/** POST /api/close */
export async function apiClose(event: H3Event): Promise<Record<string, unknown>> {
  const userId = await bearerUserId(event);
  const body = await readJsonBody(event);
  if (
    !body ||
    !isNonEmptyString(body.owner) ||
    !isNonEmptyString(body.repo) ||
    !isValidId(body.pullNumber)
  ) {
    return fail(event, 400, "Invalid request body");
  }
  const octokit = await userOctokit(event, userId);
  if (!octokit) return fail(event, 401, "Not authorized");
  try {
    await octokit.rest.pulls.update({
      owner: body.owner,
      repo: body.repo,
      pull_number: body.pullNumber,
      state: "closed",
    });
  } catch (err) {
    log.error({ err }, "Failed to close pull request");
    return fail(event, 500, "GitHub API error");
  }
  return { ok: true };
}

/** POST /api/react */
export async function apiReact(event: H3Event): Promise<Record<string, unknown>> {
  const userId = await bearerUserId(event);
  const body = await readJsonBody(event);
  const reactions = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"] as const;
  if (
    !body ||
    !isNonEmptyString(body.owner) ||
    !isNonEmptyString(body.repo) ||
    !isValidId(body.issueNumber) ||
    !isNonEmptyString(body.reaction) ||
    !(reactions as readonly string[]).includes(body.reaction)
  ) {
    return fail(event, 400, "Invalid request body");
  }
  const octokit = await userOctokit(event, userId);
  if (!octokit) return fail(event, 401, "Not authorized");
  try {
    await octokit.rest.reactions.createForIssue({
      owner: body.owner,
      repo: body.repo,
      issue_number: body.issueNumber,
      content: body.reaction as
        "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes",
    });
  } catch (err) {
    log.error({ err }, "Failed to create reaction");
    return fail(event, 500, "GitHub API error");
  }
  return { ok: true };
}
