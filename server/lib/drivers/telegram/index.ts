import MarkdownIt from "markdown-it";
import type { RouteTarget, Env, NeutralMessage } from "../../types";
import type { PlatformDriver, SendResult } from "../types";
import { sendMessage, editMessageText } from "./rest";
import { renderNeutralMessage } from "./render";

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false });

function markdownToText(value: string): string {
  return markdown.renderInline(value).replace(/<[^>]*>/gu, "");
}

function smallAvatar(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}s=64`;
}

function richHeaderUrl(message: NeutralMessage, avatar: string, host: string): string {
  const params = new URLSearchParams();
  if (message.author?.name) params.set("title", message.author.name);
  if (message.title) params.set("content", markdownToText(message.title));
  params.set("avatar", avatar);
  return `${host.replace(/\/+$/, "")}/api/richheader?${params.toString()}`;
}

/**
 * The avatar shown above the text as a link preview: the rich-header card
 * when a host serves it, the plain (small) avatar image otherwise. Messages
 * are always text messages (never photos with captions), so every edit is an
 * `editMessageText` with the full 4096-character budget.
 */
function previewUrl(message: NeutralMessage, env: Env): string | undefined {
  const avatar = message.author?.iconUrl;
  if (!avatar) return undefined;
  const richHeaderHost = env.TELEGRAM_RICH_HEADER_HOST ?? env.BASE_URL;
  return richHeaderHost ? richHeaderUrl(message, avatar, richHeaderHost) : smallAvatar(avatar);
}

export class TelegramDriver implements PlatformDriver {
  readonly id = "telegram";

  async send(message: NeutralMessage, target: RouteTarget, env: Env): Promise<SendResult> {
    const chatId = target.chatId ?? "";
    if (!chatId) {
      return { ok: false, error: "target.chatId is required", errorCode: "NO_TARGET" };
    }
    const token = env.TELEGRAM_TOKEN ?? "";
    const text = renderNeutralMessage(message);
    return sendMessage(token, chatId, text, target.topicId, previewUrl(message, env));
  }

  async edit(
    message: NeutralMessage,
    target: RouteTarget,
    env: Env,
    messageId: string,
  ): Promise<SendResult> {
    const chatId = target.chatId ?? "";
    if (!chatId) {
      return { ok: false, error: "target.chatId is required", errorCode: "NO_TARGET" };
    }
    const token = env.TELEGRAM_TOKEN ?? "";
    const text = renderNeutralMessage(message);
    // A photo sent by an older version has no text to edit; Telegram's error
    // then makes dispatch send a fresh message instead.
    return editMessageText(
      token,
      chatId,
      messageId,
      text,
      target.topicId,
      previewUrl(message, env),
    );
  }
}
