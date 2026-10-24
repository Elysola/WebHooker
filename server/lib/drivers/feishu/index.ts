import type { RouteTarget, Env, NeutralMessage } from "../../types";
import type { PlatformDriver, SendResult } from "../types";
import { forgetRejectedToken, getTenantAccessToken, sendMessage, updateMessage } from "./rest";
import { renderNeutralMessage } from "./render";

export class FeishuDriver implements PlatformDriver {
  readonly id = "feishu";

  async send(message: NeutralMessage, target: RouteTarget, env: Env): Promise<SendResult> {
    const chatId = target.chatId ?? "";
    if (!chatId) {
      return { ok: false, error: "target.chatId is required", errorCode: "NO_TARGET" };
    }
    const tokenRes = await getTenantAccessToken(env);
    if (!tokenRes.ok || !tokenRes.token) {
      return {
        ok: false,
        error: tokenRes.error ?? "No token",
        errorCode: tokenRes.errorCode ?? "NO_TOKEN",
        status: tokenRes.status,
      };
    }
    return forgetRejectedToken(
      await sendMessage(tokenRes.token, chatId, renderNeutralMessage(message), message.sendKey),
      env,
      tokenRes.token,
    );
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
    const tokenRes = await getTenantAccessToken(env);
    if (!tokenRes.ok || !tokenRes.token) {
      return {
        ok: false,
        error: tokenRes.error ?? "No token",
        errorCode: tokenRes.errorCode ?? "NO_TOKEN",
        status: tokenRes.status,
      };
    }
    return forgetRejectedToken(
      await updateMessage(tokenRes.token, messageId, renderNeutralMessage(message)),
      env,
      tokenRes.token,
    );
  }
}
