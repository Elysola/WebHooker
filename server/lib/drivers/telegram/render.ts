import MarkdownIt from "markdown-it";
import type { NeutralMessage } from "../../types";
import { splitMessageTitle } from "../../formatters/helpers";

/** Telegram caps a single message at 4096 characters (HTML entities included). */
const MAX_TEXT = 4096;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false });
md.disable(["image", "autolink"]);
md.renderer.rules.strong_open = (): string => "<b>";
md.renderer.rules.strong_close = (): string => "</b>";
md.renderer.rules.em_open = (): string => "<i>";
md.renderer.rules.em_close = (): string => "</i>";
// Telegram's HTML has no <br>: a Markdown hard break ("two spaces, newline")
// would get the whole message rejected. A plain newline breaks the line there.
md.renderer.rules.hardbreak = (): string => "\n";

function mdToHtml(s: string): string {
  return md.renderInline(s);
}

function formatTimestamp(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * Truncate Telegram HTML to `max` characters without breaking markup: drops
 * an incomplete trailing tag and closes every tag still open at the cut
 * point, so parse_mode HTML never rejects the message.
 */
function capHtml(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max).replace(/<[^>]*$/u, "");
  const stack: string[] = [];
  const re = /<(\/?)([a-z]+)(?:\s[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cut)) !== null) {
    const tag = m[2]!;
    if (m[1] === "/") {
      const open = stack.lastIndexOf(tag);
      if (open >= 0) stack.splice(open);
    } else {
      stack.push(tag);
    }
  }
  const closers = stack
    .reverse()
    .map((tag) => `</${tag}>`)
    .join("");
  return `${cut}…${closers}`;
}

export function renderNeutralMessage(message: NeutralMessage): string {
  const parts: string[] = [];

  // HTML allows partial links, so keep the `{repo}{#number}: {subject}` line
  // intact with only the repo head linked to the event's object URL (the
  // subject stays plain text).
  const { head, subject } = splitMessageTitle(message.title);
  const title = subject
    ? `<b>${message.url ? `<a href="${esc(message.url)}">${mdToHtml(head)}</a>` : mdToHtml(head)}: ${mdToHtml(subject)}</b>`
    : message.url
      ? `<b><a href="${esc(message.url)}">${mdToHtml(message.title)}</a></b>`
      : `<b>${mdToHtml(message.title)}</b>`;
  parts.push(title);

  if (message.author) {
    const name = mdToHtml(message.author.name);
    const author = message.author.url ? `<a href="${esc(message.author.url)}">${name}</a>` : name;
    parts.push(`👤 ${author}`);
  }

  if (message.description) {
    parts.push(mdToHtml(message.description));
  }

  for (const field of message.fields ?? []) {
    parts.push(`<b>${mdToHtml(field.name)}</b>: ${mdToHtml(field.value)}`);
  }

  const meta: string[] = [];
  if (message.forge) {
    const name = mdToHtml(message.forge.name);
    meta.push(message.forge.url ? `<a href="${esc(message.forge.url)}">${name}</a>` : name);
  }
  if (message.footer) meta.push(esc(message.footer));
  const ts = formatTimestamp(message.timestamp);
  if (ts) meta.push(ts);
  if (meta.length > 0) {
    parts.push(`<i>${meta.join(" · ")}</i>`);
  }

  return capHtml(parts.join("\n"), MAX_TEXT);
}
