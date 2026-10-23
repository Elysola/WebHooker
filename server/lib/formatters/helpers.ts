import type { ForgeSource, NeutralForge, NeutralMessage, WebhookEvent } from "../types";
import { t as translate } from "../lib/i18n";
import type { Translations } from "../lib/i18n";

export type T = (key: string, params?: Record<string, string | number>) => string;

export function emojiPrefix(emoji: string, show: boolean): string {
  return show ? `${emoji} ` : "";
}

export function makeT(tr?: Translations): T {
  return (key, params) => translate(key, params, undefined, tr);
}

export interface TitleParts {
  /** `{repo}` or `{repo}#{number}` — what embed titles link (the repo). */
  head: string;
  /** Text after `": "`, undefined when the title has no `: ` separator. */
  subject?: string;
}

/**
 * Split a `{repo}{#number}: {subject}` title into the repo head and the
 * subject. Discord embed titles can only link as a whole, so drivers render
 * the head as the linked title and the subject as plain text (description /
 * unlinked remainder) to avoid hyperlinking the whole title.
 */
export function splitMessageTitle(title: string): TitleParts {
  const idx = title.indexOf(": ");
  if (idx <= 0) return { head: title };
  return { head: title.slice(0, idx), subject: title.slice(idx + 2) };
}

export function buildMessage(
  partial: Omit<Partial<NeutralMessage>, "title"> & { title: string },
  t: T,
  repo?: string,
): NeutralMessage {
  return {
    ...partial,
    footer: partial.footer ?? t("common.footer", { repo: repo ?? t("common.github") }),
    timestamp: partial.timestamp ?? new Date().toISOString(),
  };
}

/**
 * Base URL of the forge repo (e.g. `https://github.com/owner/repo` or a Gitea
 * instance URL). Derived from `repository.html_url` in the payload so it works
 * for any provider; falls back to github.com for legacy payloads.
 */
export function repoBaseUrl(payload: Record<string, unknown>, repo?: string): string | undefined {
  const html = (payload.repository as { html_url?: string } | undefined)?.html_url;
  if (html) return html;
  return repo ? `https://github.com/${repo}` : undefined;
}

function encodeRefPath(ref: string): string {
  return ref
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** Inline code + hyperlink for a commit, e.g. [`abc123d`](.../commit/abc123def456). */
export function commitLink(baseUrl: string | undefined, sha: string, short?: string): string {
  const label = short ?? sha.slice(0, 7);
  return baseUrl ? `[\`${label}\`](${baseUrl}/commit/${encodeRefPath(sha)})` : `\`${label}\``;
}

/** Inline code + hyperlink for a branch (or bare ref), e.g. [`main`](.../tree/main). */
export function branchLink(baseUrl: string | undefined, branch: string, label?: string): string {
  const clean = branch.replace("refs/heads/", "").replace("refs/tags/", "");
  const display = label ?? clean;
  return baseUrl ? `[\`${display}\`](${baseUrl}/tree/${encodeRefPath(clean)})` : `\`${display}\``;
}

/** Inline code + hyperlink for a tag, e.g. [`v1.0`](.../releases/tag/v1.0). */
export function tagLink(baseUrl: string | undefined, tag: string, label?: string): string {
  const clean = tag.replace("refs/tags/", "");
  const display = label ?? clean;
  return baseUrl
    ? `[\`${display}\`](${baseUrl}/releases/tag/${encodeRefPath(clean)})`
    : `\`${display}\``;
}

/** URL for a branch or tag, when the repository base URL is available. */
export function refUrl(
  baseUrl: string | undefined,
  ref: string,
  type: "branch" | "tag",
): string | undefined {
  if (!baseUrl) return undefined;
  const clean = ref.replace("refs/heads/", "").replace("refs/tags/", "");
  return type === "tag"
    ? `${baseUrl}/releases/tag/${encodeRefPath(clean)}`
    : `${baseUrl}/tree/${encodeRefPath(clean)}`;
}

/* ---- Content size limits (mirror the Discord embed limits) ---- */
export const MAX_TITLE = 256;
export const MAX_DESCRIPTION = 4096;
export const MAX_FIELD_VALUE = 1024;
export const MAX_FIELDS = 25;
export const MAX_FOOTER = 2048;
/** First-line commit message length (stays well under the field value budget). */
export const MAX_COMMIT_SUBJECT = 200;

/** Truncate a string to `max` characters. */
export function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** A numeric character reference, kept verbatim when it names no valid code point. */
function codePoint(value: number, original: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return original;
  if (value >= 0xd800 && value <= 0xdfff) return original;
  return String.fromCodePoint(value);
}

export function htmlToText(input: string): string {
  if (!input) return "";
  let out = input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<table[^>]*>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table|blockquote)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "  ")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, "");
  out = out
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => codePoint(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec: string) => codePoint(Number(dec), m))
    .replace(/&amp;/gi, "&");
  out = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}

/**
 * Normalize a check/workflow status: `queued` / `in_progress` keep their
 * value (the latter becomes `running`), anything else falls back to the
 * conclusion and finally `pending`.
 */
export function workflowStatus(status?: string, conclusion?: string): string {
  if (status === "queued") return "queued";
  if (status === "in_progress") return "running";
  return conclusion ?? "pending";
}

/** workflow_run events derive their progress from the action, not `status`. */
export function workflowRunStatus(action?: string, conclusion?: string): string {
  if (action === "in_progress") return "running";
  if (action === "requested") return "queued";
  return conclusion ?? "pending";
}

/** GITHUB_COLORS key for a success/failure/other status. */
export function statusColorKey(
  prefix: "check_run" | "workflow_run",
  status: string,
): `${typeof prefix}_${"success" | "failure" | "other"}` {
  return status === "success"
    ? `${prefix}_success`
    : status === "failure"
      ? `${prefix}_failure`
      : `${prefix}_other`;
}

/**
 * The sender's profile URL on the same forge as the repo (derived from the
 * repo's html_url origin, e.g. `https://github.com/owner/repo` →
 * `https://github.com/login`). Falls back to github.com when the repo URL is
 * unavailable or unparseable.
 */
export function senderProfileUrl(repoUrl: string | undefined, login: string): string {
  if (repoUrl) {
    try {
      return `${new URL(repoUrl).origin}/${encodeURIComponent(login)}`;
    } catch {
      // unparseable repo URL — fall through to github.com
    }
  }
  return `https://github.com/${login}`;
}

/**
 * Forge branding for an event, driven by the group's own forgeSources list.
 * The event's repository host (github.com for GitHub, the instance hostname
 * for Gitea) is matched case-insensitively against the configured hosts; the
 * first entry whose type and host both match wins. The footer label is the
 * entry's display `name` (or its host when no name is set). Link is derived
 * from the repository URL; the footer icon uses a raster PNG Discord can
 * render (GitHub's fluidicon, Gitea's /assets/img/favicon.png).
 */
export function forgeInfo(event: WebhookEvent, sources?: ForgeSource[]): NeutralForge | undefined {
  const repoUrl = (event.payload.repository as { html_url?: string } | undefined)?.html_url;
  let host: string | undefined;
  if (repoUrl) {
    try {
      host = new URL(repoUrl).hostname.toLowerCase();
    } catch {
      // unparseable repo URL — fall through
    }
  }
  // GitHub events without a repository (e.g. ping) still match github.com.
  if (!host && event.provider === "github") host = "github.com";
  if (!host) return undefined;

  const source = sources?.find((s) => s.type === event.provider && s.host.toLowerCase() === host);
  if (!source) return undefined;

  const label = source.name?.trim() || source.host;
  const githubIcon = "https://github.com/fluidicon.png";
  if (repoUrl) {
    try {
      const origin = new URL(repoUrl).origin;
      return {
        name: label,
        url: origin,
        iconUrl: event.provider === "github" ? githubIcon : `${origin}/assets/img/favicon.png`,
      };
    } catch {
      // unparseable repo URL — name only
    }
  }
  if (event.provider === "github") {
    return { name: label, url: "https://github.com", iconUrl: githubIcon };
  }
  return { name: label };
}
