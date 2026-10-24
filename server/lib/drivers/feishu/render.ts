import type { NeutralMessage } from "../../types";
import { cap, splitMessageTitle } from "../../formatters/helpers";

const MAX_HEADER_TITLE = 100;
const MAX_MARKDOWN = 4000;
const MAX_NOTE = 500;

type FeishuTemplate =
  "blue" | "green" | "red" | "yellow" | "orange" | "purple" | "indigo" | "wathet" | "lime" | "grey";

function colorToTemplate(color?: number): FeishuTemplate {
  if (color == null) return "blue";
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const max = Math.max(r, g, b);
  if (max < 80) return "grey";
  if (r > g + b && g < 100) return "red";
  if (g > r + b && g > 150) return "green";
  if (b > r + g) return "indigo";
  if (r > 180 && g > 120 && b < 80) return "orange";
  if (r > 200 && g > 180 && b < 120) return "yellow";
  if (r > 120 && g < 80 && b > 120) return "purple";
  if (r > 160 && g > 180 && b > 200) return "wathet";
  if (g > 150 && r > 150 && b < 80) return "lime";
  return "blue";
}

/**
 * Text from the forge (titles, bodies, names) is anyone's to write: an
 * `<at id=all></at>` in an issue title would make the bot notify the whole
 * chat. The card never mentions anyone itself, so every `<at` tag is broken
 * up (a zero-width space after `<`) and shows as text.
 */
function noMentions(content: string): string {
  // Escape every angle bracket, not only `<at`. Replacing just the mention
  // prefix still leaves values such as `<script` in Feishu markdown, where an
  // incomplete tag can be interpreted as HTML by the client.
  return content.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdText(content: string): { tag: "lark_md"; content: string } {
  return { tag: "lark_md", content: cap(noMentions(content), MAX_MARKDOWN) };
}

function divMarkdown(content: string): { tag: "div"; text: { tag: "lark_md"; content: string } } {
  return { tag: "div", text: mdText(content) };
}

function formatTimestamp(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function renderNeutralMessage(message: NeutralMessage): Record<string, unknown> {
  const { head, subject } = splitMessageTitle(message.title);

  const elements: Record<string, unknown>[] = [];

  if (message.url) {
    elements.push(divMarkdown(`**[${head}](${message.url})**`));
  }

  if (message.author?.name) {
    const author = message.author.url
      ? `[${message.author.name}](${message.author.url})`
      : message.author.name;
    elements.push(divMarkdown(`**${author}**`));
  }

  if (subject || message.url || message.description) {
    const parts: string[] = [];
    if (subject) {
      parts.push(`**${subject}**`);
    } else if (message.url) {
      parts.push(`**${message.title}**`);
    }
    if (message.description) {
      parts.push(message.description);
    }
    if (parts.length) {
      elements.push(divMarkdown(parts.join("\n\n")));
    }
  }

  if (message.fields?.length) {
    const lines = message.fields.map((f) => `**${f.name}**: ${f.value}`);
    elements.push(divMarkdown(lines.join("\n\n")));
  }

  const meta: string[] = [];
  if (message.forge?.name) {
    meta.push(
      message.forge.url ? `[${message.forge.name}](${message.forge.url})` : message.forge.name,
    );
  }
  if (message.footer) meta.push(message.footer);
  const ts = formatTimestamp(message.timestamp);
  if (ts) meta.push(ts);

  if (meta.length) {
    if (elements.length) elements.push({ tag: "hr" });
    elements.push({
      tag: "note",
      elements: [{ tag: "lark_md", content: cap(noMentions(meta.join(" · ")), MAX_NOTE) }],
    });
  }

  if (message.url && !message.actions?.length) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "Open" },
          type: "primary",
          multi_url: {
            url: message.url,
            pc_url: message.url,
            android_url: message.url,
            ios_url: message.url,
          },
        },
      ],
    });
  }

  if (message.actions?.length) {
    elements.push({
      tag: "action",
      actions: message.actions.map((action) => ({
        tag: "button",
        text: { tag: "plain_text", content: action.label },
        type:
          action.style === "danger" ? "danger" : action.style === "primary" ? "primary" : "default",
        action_id: action.id,
        value: { v: action.id },
      })),
    });
  }

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: true,
    },
    header: {
      title: {
        tag: "plain_text",
        content: cap(head, MAX_HEADER_TITLE),
      },
      template: colorToTemplate(message.color),
    },
    elements,
  };
}
