import type { RouteTarget } from "../types";
import type { PlatformDriver } from "./types";
import { DiscordDriver } from "./discord";
import { TelegramDriver } from "./telegram";
import { FeishuDriver } from "./feishu";

const drivers: Record<string, PlatformDriver> = {
  discord: new DiscordDriver(),
  telegram: new TelegramDriver(),
  feishu: new FeishuDriver(),
};

export function getDriver(target: RouteTarget): PlatformDriver {
  const platform = target.platform ?? "discord";
  const driver = drivers[platform];
  if (!driver) throw new Error(`No driver for platform "${platform}"`);
  return driver;
}

/**
 * Where a target's messages actually go: two targets naming the same place
 * (a Discord thread given alone, or with its parent channel) are one
 * destination, and get one copy of each message.
 */
export function destinationOf(target: RouteTarget): string {
  const platform = target.platform ?? "discord";
  if (platform === "telegram") {
    // Read as the driver sends it (a number): `01` and `1` are one topic.
    const topic = target.topicId ?? "";
    const id = topic && Number.isFinite(Number(topic)) ? String(Number(topic)) : topic;
    return `telegram:${target.chatId ?? ""}/${id}`;
  }
  if (platform === "feishu") return `feishu:${target.chatId ?? ""}`;
  return `discord:${target.threadId || target.channelId || ""}`;
}
