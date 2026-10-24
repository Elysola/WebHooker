# 简介

WebHooker 是一个基于 Cloudflare Workers 构建的 GitHub/Gitea webhook 调度器。它接收来自受支持 forge（GitHub、Gitea——更多可通过 `server/lib/providers/` 扩展）的 webhook 事件，应用可配置的过滤器，将事件格式化为富消息，并通过各自 REST API 投递到 Discord 频道/子区（embed）与 Telegram 群组/话题（HTML）。Discord 内的 `/gh` 交互通过 HTTPS Interactions Endpoint（Ed25519 验签）送达；Telegram 的 `/gh` 命令通过 Telegram webhook 送达。路由与分组通过内置的 Web UI 管理。

## 架构

```text
GitHub / Gitea Webhook → Cloudflare Worker (Nuxt 4 / Nitro)
                 ├── POST /webhook → 识别提供方 → 验证 → 去重 → 过滤 → 格式化 → Discord (REST) / Telegram (Bot API)
                 ├── POST /discord/interactions → 验证 (Ed25519) → 处理 /gh 斜杠与右键命令
                 ├── POST /telegram/webhook → 验证 (secret token) → 处理 /gh 命令
                 ├── GET  /auth/github → OAuth 流程
                 ├── GET  /api/richheader → Telegram 头像链接预览卡片
                 ├── POST /api/* → 用户操作 (Bearer Token 鉴权)
                 ├── /admin → 路由、分组与发送日志 Web UI（管理员会话）
                 └── GET  /health → 健康检查
```

### 组件

| 组件                      | 职责                                                                                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare Worker**     | HTTP 入口、签名验证、投递去重、事件解析、路由匹配、平台分发                                                                                                                                                                                                                   |
| **Interactions Endpoint** | 验证 Ed25519 签名并处理 `/gh` 交互（斜杠命令、右键菜单、按钮、modal）                                                                                                                                                                                                         |
| **KV**                    | Token 存储 (`token:{userId}`)、OAuth 状态 (`state:{hex}`)、管理员会话、邀请、投递去重/投递状态/消息更新追踪的回退（`delivery:*`、`delivery-state:*`、`msg:*`，仅在 D1 不可用时使用）、消息更新锁 (`msg:lock:*`)                                                               |
| **D1**                    | 路由/分组 (`d1_routes`/`d1_groups`)、发送日志 (`send_logs`)、审计日志 (`audit_logs`)、去重 (`dedup_keys`)、投递状态 (`delivery_state`)、消息追踪 (`message_tracking`)、Discord↔GitHub 绑定 (`discord_links`)、Telegram↔GitHub 绑定 (`telegram_links`)，超大负载可选的 R2 存储 |

### 数据流

1. 某个 forge（GitHub 或 Gitea）发送 webhook 到 `POST /webhook`
2. Worker 根据请求头识别提供方（`X-GitHub-Event` / `X-Gitea-Event`）并验证对应提供的 HMAC-SHA256 签名
3. Worker 按投递 ID 去重（D1，短 TTL，KV 回退），丢弃重复投递
4. Worker 解析事件类型并将载荷归一化为 GitHub 形状的事件
5. 根据过滤器（event、repo、actor、action、branch、keyword）与分组所有者限制评估路由
6. 匹配的路由触发格式化器函数生成平台中立消息
7. 每条消息通过 Discord 或 Telegram REST API 发送到对应路由的目标，并处理速率限制重试；`workflow_run` / `check_run` 进度原地更新。每次尝试都记录到 D1 发送日志

## 技术栈

- **运行时**: Cloudflare Workers
- **HTTP 框架**: Nuxt 4 / Nitro (H3)
- **Discord 投递**: Discord REST API（交互通过 Ed25519 验签的 HTTPS Interactions Endpoint）
- **Telegram 投递**: Telegram Bot API（webhook 调用始终用 secret token 校验——显式配置，或由 bot token 派生）
- **Web UI**: Nuxt 4（Vue 3 + Tailwind CSS v4 + `@elysola/ui`）——首页/法律页面服务端渲染，`/admin` 控制台客户端渲染
- **存储**: Cloudflare D1（配置与日志权威）+ KV（缓存/临时状态）+ 可选 R2（超大负载）
- **鉴权**: Web Crypto API (HMAC-SHA256、Ed25519)、octokit (GitHub API)
- **语言**: TypeScript

## 许可证

MIT
