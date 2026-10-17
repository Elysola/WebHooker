# WebHooker

GitHub / Gitea webhook → Discord / Telegram / 飞书 分发服务。通过 Cloudflare Workers 接收 webhook 事件，应用过滤器，将格式化消息路由到 Discord 频道/子区、Telegram 群组/话题与飞书群聊卡片。各 forge 适配器位于 `server/lib/providers/`（目前支持 GitHub + Gitea；GitLab 等可后续扩展）。

## 功能特性

- **28 种事件格式化** — push、pull_request、issues、issue_comment、workflow_run、workflow_job、status、deployment、deployment_status、check_run、check_suite、ping、release、create、delete、star、fork、pull_request_review、pull_request_review_comment、commit_comment、member、label、milestone、discussion、discussion_comment、repository、code_scanning_alert、dependabot_alert（+ 通用回退，+ `custom` 自定义 webhook）
- **多平台 webhook** — GitHub（`X-Hub-Signature-256`）与 Gitea（`X-Gitea-Signature`）共用 `/webhook` 端点，自动识别来源平台
- **分组级 webhook 入口** — 每个分组可拥有独立的 `POST /webhook/{groupId}` URL + secret（Gitea、classic GitHub webhook，以及用 `X-WebHooker-Signature` 签名的任意自定义 JSON，可选的 timestamp+nonce 重放防护）
- **GitHub App 租户隔离** — 将分组绑定到 GitHub App 安装 ID，只有该组织/用户的事件才能进入该分组
- HMAC-SHA256 签名验证（Web Crypto API）
- 按事件类型、仓库、操作人、操作、分支、关键词，或任意载荷字段（`field` + JSONPath `path`，如 `pull_request.user.login`）过滤；支持 `*`/`?` 通配符与 `/正则/`，另有 12 个比较操作符（`eq`/`ne`/`contains`/`startsWith`/`endsWith`/`regex`/`gt`/`gte`/`lt`/`lte`/`in`/`exists`）
- 在路由编辑器的可视化构建器中把过滤器组合成布尔 AST（`all` / `any` / `not` 节点）；可复用命名过滤器片段，并可对粘贴的 JSON 载荷做无存储的试匹配
- 富消息：颜色编码、作者头像、字段、时间戳——渲染为 Discord embed 与 Telegram HTML
- 路由到 Discord 频道/子区、Telegram 群组/话题与飞书群聊（一条路由可多目标）
- `workflow_run` / `check_run` 进度**原地编辑**同一条消息（运行推进时更新），Discord、Telegram 与飞书均支持 —— `check_run` 以 check 名 + commit SHA 追踪，因此每个阶段都换新 run id 的部署（如 Cloudflare Pages）仍会编辑同一条消息；`workflow_run` 内嵌带颜色的逐作业代码块（🟢 成功、🔴 失败、运行中/排队中不着色）
- **分组级 Webhook 日志频道** —— 为分组指定一个 Discord 频道/子区、Telegram 群组/话题或飞书群聊，该分组路由每次分发 webhook 都会向其中发送摘要（每条「路由 × 目标」一行，✅/❌ 结果）
- GitHub OAuth 用户授权（评论、编辑评论、删除评论、合并、关闭、反应）
- **Web 配置控制台**（`/admin`）— 基于 Elysola UI，使用居中路由/分组对话框；通过 GitHub OAuth + 管理员白名单管理路由与分组、查看发送日志
- **Discord Interactions Endpoint**（Ed25519 验签）支持 `/gh` 斜杠命令、消息右键菜单命令、PR 合并/关闭按钮与评论 modal
- **Telegram `/gh` 命令**（login/logout/comment/merge/close），通过 Telegram webhook 接收，头像以链接预览卡片呈现
- Cloudflare D1 存储配置（路由/分组）、发送日志、平台账号绑定、去重、投递状态与消息更新追踪 + KV 存储临时状态/缓存/安全令牌 + 可选 R2 存储超大负载
- **Cloudflare Queues 异步投递** —— 绑定 `QUEUE` 时，已验签的 webhook 会入队到 `webhooker-delivery`，由消费者分发，带指数退避重试（5s/30s/2m/10m）与死信队列（`webhooker-delivery-dlq`）；超大负载暂存于 R2（`PAYLOAD` 绑定，回退 KV `queue:payload:*`）。未绑定则保持同步分发
- 优雅降级（Discord 不可用时仅 webhook 模式）

## 架构

```text
GitHub Webhook → Cloudflare Worker (Nuxt 4 / Nitro)
                  ├── POST /webhook → 验证 → 去重 → 入队 (Queue) → 分发 → Discord (REST) / Telegram (Bot API) / 飞书 (Bot API)
                 ├── POST /discord/interactions → 验证 (Ed25519) → 处理命令/按钮/modal
                 ├── POST /telegram/webhook → 验证 (secret token) → 处理 /gh 命令
                 ├── GET  /auth/github → OAuth 流程
                 ├── GET  /api/richheader → Telegram 头像链接预览卡片
                 ├── POST /api/* → 用户操作（Bearer token 鉴权）
                 ├── /admin → 路由、分组与发送日志 Web UI
                 └── GET  /health → 健康检查
```

- **Cloudflare Worker** — HTTP 入口、签名验证、路由分发
- **Interactions Endpoint** — HTTPS 回调（无 Discord Gateway 连接、无 Durable Object）；bot 保持离线，命令通过 API 注册
- **KV** — 缓存 + 临时状态：Token 存储（`token:{userId}`）、OAuth state（`state:{hex}`）、管理员会话（`session:{id}`）、分组级 webhook secret（`tenant:{groupId}`）、邀请、配置缓存、投递去重/投递状态/消息更新追踪的回退（`delivery:*`、`delivery-state:*`、`msg:*` 仅在 D1 不可用时使用）与消息更新锁（`msg:lock:*`）
- **D1** — 路由/分组（`d1_routes`/`d1_groups`）、命名过滤器片段（`d1_fragments`）、发送日志（`send_logs`）、审计日志（`audit_logs`）、去重（`dedup_keys`）、投递状态（`delivery_state`）、消息更新追踪（`message_tracking`）、Discord↔GitHub 绑定（`discord_links`）、Telegram↔GitHub 绑定（`telegram_links`）
- **Queue** — 绑定 `QUEUE` 时异步投递：`webhooker-delivery`（指数退避重试）+ 死信队列 `webhooker-delivery-dlq`；超大负载暂存于 R2（`PAYLOAD` 绑定，`webhooks/YYYY/MM/DD/*.json`，回退 KV `queue:payload:*`）

## 快速开始

```bash
bun install          # 包管理器为 bun（锁文件：bun.lock）
cp .env.example .dev.vars   # 填写本地开发密钥
bun run build        # 先构建生产产物（wrangler dev 运行的是构建产物）
bunx wrangler dev    # 启动本地开发服务器
```

## 配置

### 密钥（本地用 `.dev.vars`，生产用 Worker Secrets）

| 变量                        | 说明                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`     | GitHub webhook 密钥                                                         |
| `GITEA_WEBHOOK_SECRET`      | Gitea webhook 密钥（仅接收 Gitea webhook 时需要）                           |
| `GITHUB_APP_ID`             | GitHub App ID（用于 App 安装流程解析安装所属账号）                          |
| `GITHUB_PRIVATE_KEY`        | App 私钥（PKCS#8 PEM；用于 App 安装流程，可选）                             |
| `GITHUB_CLIENT_ID`          | OAuth Client ID                                                             |
| `GITHUB_CLIENT_SECRET`      | OAuth Client Secret                                                         |
| `DISCORD_TOKEN`             | 机器人 token                                                                |
| `DISCORD_PUBLIC_KEY`        | Discord 应用的公钥（开发者门户获取）—— 交互功能必需                         |
| `DISCORD_APPLICATION_ID`    | Discord 应用 ID（可选；省略时通过 `GET /oauth2/applications/@me` 自动获取） |
| `TELEGRAM_TOKEN`            | Telegram Bot Token（BotFather 获取）—— Telegram 路由必需                    |
| `TELEGRAM_WEBHOOK_SECRET`   | 可选；`POST /telegram/webhook` 的验签密钥                                   |
| `TELEGRAM_RICH_HEADER_HOST` | 可选；覆盖内置 `GET /api/richheader` 的 Telegram 头像卡片地址               |
| `FEISHU_APP_ID`             | 飞书应用 ID（应用凭证页获取）—— 飞书路由必需                                |
| `FEISHU_APP_SECRET`         | 飞书应用密钥 —— 飞书路由必需                                                |
| `BASE_URL`                  | 公网地址（用于 OAuth 回调与 Telegram webhook 同步）                         |
| `ADMIN_USER_IDS`            | 允许访问 `/admin` 的 GitHub 用户 ID（或登录名），逗号分隔                   |
| `DEBUG_MODE`                | 仅本地开发：精确设为 `true` 时跳过全部 `/admin` 身份验证                    |
| `ALLOW_SELF_SIGNUP`         | 设为 `1` 时，无权限的 GitHub 用户首次登录自动获得个人分组（默认关闭）       |
| `AUDIT_RETENTION_DAYS`      | 定时清理时审计日志的保留天数（默认 90）                                     |
| `NUXT_PUBLIC_DOCS_URL`      | 可选；落地页使用的文档站点 URL                                              |
| `NUXT_PUBLIC_REPO_URL`      | 可选；落地页使用的 GitHub 仓库 URL                                          |
| `NUXT_PUBLIC_LEGAL_CONTACT` | 可选；`/terms` 与 `/privacy` 页面展示的联系方式                             |

### 路由配置

路由存储在 D1（`d1_routes`，首次加载时从旧版 KV `config:routes` 同步）。**没有默认路由**——每条路由（包括目标）都必须显式定义，可通过 Web 控制台（`/admin`）或直接向 D1 存储 JSON 数组。一条路由可携带多个 `targets`，因此一个规则可以同时转发到多个频道：

```json
[
  {
    "id": "all-push",
    "name": "Push 事件",
    "enabled": true,
    "groupId": "default",
    "filters": [{ "type": "event", "match": "push" }],
    "stop": true,
    "targets": [
      { "platform": "discord", "channelId": "频道ID" },
      { "platform": "telegram", "chatId": "-1001234567890" },
      { "platform": "feishu", "chatId": "oc_xxx" }
    ]
  }
]
```

`target.platform` 选择推送目标：`discord`（默认）、`telegram` 或 `feishu`。Discord 目标需 `target.channelId`（可选 `threadId` 指向子区）；Telegram 目标需 `target.chatId`（可选 `topicId` 指向话题）；飞书目标需 `target.chatId`（可选 `topicId` 指向子话题）。路由还可设置 `stop: true`（跳过本分组的后续路由）。路由隶属于**分组**（D1 `d1_groups`，首次加载时从旧版 KV `config:groups` 同步），分组用于限定管理权限，并可限制哪些组织/用户的事件流入。完整模式见[路由与目标](https://webhooker.docs.elysola.org/zh/guide/routes)与[分组与访问控制](https://webhooker.docs.elysola.org/zh/guide/groups)指南。

### Web 控制台（`/admin`）

内置的配置控制台让你在浏览器中管理路由与分组（新增 / 编辑 / 删除 / 开关 / 拖动排序——保存的顺序即评估顺序）、查看发送日志、管理组成员与邀请链接、阅读审计日志——无需直接操作 D1 或 KV：

1. 设置 `ADMIN_USER_IDS` 为允许管理控制台的 GitHub 用户 ID（或登录名），例如 `ADMIN_USER_IDS=12345,RhenCloud`。
2. 访问 `/admin` 并用 GitHub 登录。无任何权限的用户收到 `403`——除非开启 `ALLOW_SELF_SIGNUP=1`（自动获得个人分组）或通过分组邀请链接加入。
3. 修改会立即写入 D1，配置缓存随之失效，webhook 管线随即生效。

仅限本地调试时，可设 `DEBUG_MODE=true` 跳过 GitHub OAuth 并获得完整控制台权限。部署环境切勿设置此变量。

在 `/admin/logout` 退出登录。每个分组都有带角色的 `members`（`owner` / `admin` / `viewer`）；所有管理操作（登录、分组/路由/成员/邀请变更）都会写入 D1 `audit_logs` 表。

### 过滤器类型

所有过滤器均支持纯文本、`*`/`?` 通配符与 `/正则/`（不区分大小写）；设置 `exclude: true` 可取反。`field` 过滤器通过 JSONPath（`path`）读取任意载荷字段（数组会展开，任一元素匹配即可），并可用 `op` 指定比较操作符（默认 `eq`）；`op: "exists"` 只判断字段是否存在、无需 `match`。过滤器还可通过路由上可选的 `ast`（`all` / `any` / `not` 节点）组合为 AST，以表达默认 AND 列表之外的布尔组合——当 `ast` 存在时优先于 `filters`。路由编辑器提供可视化 AST 构建器、chip 多值输入、无状态试匹配器与命名过滤器片段（存于 D1 `d1_fragments`）。模式语法与完整过滤器参考见[过滤器教程](https://webhooker.docs.elysola.org/zh/guide/filters)。

## API

### 健康检查

- `GET /health` — 返回 `{"status": "ok"}`

### OAuth

- `GET /auth/github` — 发起 GitHub OAuth 授权（重定向到 GitHub）
- `GET /auth/github/callback` — OAuth 回调（交换 code 为 token；管理员会话 / Discord 绑定 / Telegram 绑定）
- `DELETE /auth/token/:userId` — 撤销用户 token

### 操作接口（需要 `Authorization: Bearer <token>` 头）

- `POST /api/comment` — 创建 issue 评论
- `POST /api/merge` — 合并 PR
- `POST /api/close` — 关闭 PR
- `POST /api/react` — 添加 issue 反应

### 管理接口（需要管理员 OAuth 会话）

- `GET /admin` — 配置控制台页面
- `GET /admin/login` — 开始管理员登录（GitHub OAuth）
- `GET /admin/logout` — 退出登录
- `GET /admin/invite?token=…` — 接受分组邀请（浏览器页面）
- `GET /admin/api/routes` — 列出路由
- `PUT /admin/api/routes` — 替换路由（按分组 owner/admin 权限）
- `GET /admin/api/groups` — 列出分组 + 你的角色
- `PUT /admin/api/groups` — 替换分组（超管全量；owner 仅自己的组）
- `GET /admin/api/groups/:groupId/routes` — 列出某分组的路由
- `PUT /admin/api/groups/:groupId/routes` — 替换某分组的路由
- `POST /admin/api/groups/:groupId/invites` — 创建邀请链接（owner）
- `GET /admin/api/groups/:groupId/invites` — 列出待接受邀请（owner）
- `DELETE /admin/api/invites/:token` — 撤销邀请（owner）
- `GET /admin/api/audit` — 审计日志（按权限过滤）
- `GET /admin/api/me` — 当前会话 / 权限范围 / 角色
- `GET /admin/api/logs` — 发送日志（按权限过滤）
- `GET /admin/api/logs/:id` — 单条发送日志
- `GET /admin/api/metrics` — 投递统计（总计、失败率、按平台/事件/状态、最近失败）；可选 `?groupId=` 按分组过滤
- `GET /admin/api/delivery/:deliveryId` — 单次投递的全部发送日志

## 配置教程

- **GitHub App** — 创建应用、订阅事件、配置 OAuth 与 _Setup URL_（租户隔离）：见 [GitHub App 配置](https://webhooker.docs.elysola.org/zh/guide/deployment#github-app-设置)
- **Discord 机器人** — 创建机器人、以 `applications.commands` scope 邀请（组合权限整数 `274877910016`）、配置 Interactions Endpoint：见 [Discord Bot 配置](https://webhooker.docs.elysola.org/zh/guide/deployment#discord-bot-设置)。bot 从不连接 Discord Gateway，因此显示为**离线**——消息推送不受影响（始终走 REST）。
- **Telegram 机器人** — 用 [@BotFather](https://t.me/BotFather) 创建机器人，设置 `TELEGRAM_TOKEN`（可选 `TELEGRAM_WEBHOOK_SECRET`）；webhook 由定时任务自动同步：见 [Telegram 机器人配置](https://webhooker.docs.elysola.org/zh/guide/deployment#telegram-机器人配置)
- **部署** — KV 命名空间、D1 数据库与迁移（含 0008 存储表）、可选 R2 Bucket 与 Queues、密钥、部署：见[部署指南](https://webhooker.docs.elysola.org/zh/guide/deployment)

### Bot 指令（以本人身份评论 GitHub）

bot 通过定时任务（每 5 分钟）同步注册原生的**斜杠命令**与**消息右键菜单命令**：按服务器注册以获得即时可用性，并全局注册（24h 去重，约 1 小时传播）。执行 `/gh login` 后即可评论 issue/PR、编辑/删除自己的评论，并通过按钮合并/关闭 PR——所有回复均为临时消息（仅你可见），权限交由 GitHub 判定。

```
/gh login  /gh logout
/gh comment add|edit|del  link:<链接>      （或右键通知 → 应用 → GitHub: 添加/编辑/删除评论）
```

完整参考见[机器人命令指南](https://webhooker.docs.elysola.org/zh/guide/commands)。

## 开发命令

```bash
bun run dev           # Nuxt 开发服务器（HMR）
bun run typecheck     # 类型检查
bun run lint          # ESLint
bun test              # 单元测试
```

## 支持的事件

28 个事件格式化器（push、pull_request、issues、workflow_run、release 等）外加 `custom` webhook；不支持的事件回退到通用格式化器。带嵌入亮点的完整表格见[支持的事件](https://webhooker.docs.elysola.org/zh/events/supported)。

## 许可证

MIT
