# 部署

## Cloudflare 设置

### 1. 创建 KV 命名空间

```bash
bunx wrangler kv namespace create KV
```

这会输出一个命名空间 ID。更新 `wrangler.jsonc`，填入 ID：

```jsonc
{
  "kv_namespaces": [
    {
      "binding": "KV",
      "id": "your-namespace-id",
    },
  ],
}
```

### 2. 设置密钥

```bash
bunx wrangler secret put GITHUB_WEBHOOK_SECRET
bunx wrangler secret put GITHUB_CLIENT_ID
bunx wrangler secret put GITHUB_CLIENT_SECRET
bunx wrangler secret put DISCORD_TOKEN
bunx wrangler secret put DISCORD_PUBLIC_KEY   # Discord 应用的公钥（开发者门户获取），交互功能必需
bunx wrangler secret put TELEGRAM_TOKEN       # Telegram Bot Token（BotFather 获取）—— Telegram 路由必需
bunx wrangler secret put FEISHU_APP_ID        # 飞书应用 ID —— 飞书路由必需
bunx wrangler secret put FEISHU_APP_SECRET    # 飞书应用密钥 —— 飞书路由必需
bunx wrangler secret put ADMIN_USER_IDS       # 逗号分隔的 GitHub ID/登录名，允许进入 Web UI
```

::: tip 目标频道按路由配置
不存在全局频道密钥。每条路由在 [Web 控制台](/zh/guide/configuration#web-控制台) 中声明各自的目标频道（及可选的子区/thread），因此不需要 `DISCORD_CHANNEL_ID`。
:::

::: tip GitHub App ID / 私钥为可选
`GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY`（PKCS#8 PEM）用于 [App 安装流程](#github-app-设置)，在安装后选择页解析安装所属账号的登录名，并用于签发安装令牌做 API 增强——拉取 `workflow_run` 作业列表与 check-suite 构建日志。可以跳过不设——安装页会显示匿名 `inst-{installationId}` 分组，公开仓库的作业列表仍会以匿名方式加载，私有仓库的构建日志则省略。OAuth 流程只需要 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`。
:::

Discord 交互通过 HTTPS Interactions Endpoint 送达，需要设置 `DISCORD_PUBLIC_KEY` 并把 **Interactions Endpoint URL** 指向 `https://your-domain/discord/interactions`。参见下方 [Interactions Endpoint](#interactions-endpoint)。

### 3. 创建 D1 数据库并执行迁移

```bash
bunx wrangler d1 create webhooker
```

将返回的数据库 ID 填入 `wrangler.jsonc`：

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "webhooker",
      "database_id": "your-database-id",
    },
  ],
}
```

然后执行迁移：

```bash
bun run db:migrate:prod   # 将迁移应用到远端 D1 数据库
bun run db:migrate        # 将迁移应用到本地（Miniflare）数据库
```

`db:migrate` 脚本执行 `wrangler d1 migrations apply webhooker`（见 `package.json`），逐一应用 `migrations/` 下的 SQL 文件，并在 `d1_migrations` 表中记录已应用的版本。

::: tip 曾用 `d1 execute` 迁移过的数据库
如果数据库已有这些表/列（例如之前用 `wrangler d1 execute --file` 迁移过），可能缺少 `d1_migrations` 追踪表，`db:migrate:prod` 会尝试重新执行所有迁移；`0002_log_detail.sql` 中的 `ALTER TABLE ... ADD COLUMN` 语句会因列已存在而失败。此时请直接执行文件：

```bash
bunx wrangler d1 execute webhooker --remote --file ./migrations/0001_init.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0002_log_detail.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0003_telegram_links.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0004_add_group_id.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0005_audit_logs.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0006_config_d1.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0007_send_logs_index.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0008_storage_d1.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0010_fragments.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0011_feishu_links.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0012_route_position.sql
```

:::

### 4. 创建 R2 Bucket（可选）

`PAYLOAD` 绑定将超大 webhook 负载暂存在 R2（`webhooker-payloads`）而非 KV。未设置时，超大负载回退到 KV 键 `queue:payload:*`。布局见[存储](/zh/guide/storage)。

```bash
bunx wrangler r2 bucket create webhooker-payloads
```

bucket 已在 `wrangler.jsonc` 中声明（`r2_buckets`），无需修改绑定。

### 5. 创建队列（可选）

`QUEUE` 绑定会通过 Cloudflare Queues 投递 webhook（异步分发，带重试退避与死信队列）。跳过此步则保持同步内联分发。

```bash
bunx wrangler queues create webhooker-delivery
bunx wrangler queues create webhooker-delivery-dlq
```

队列已在 `wrangler.jsonc` 中声明（`queues.producers` / `queues.consumers`），无需修改绑定。`webhooker-delivery` 消费者对可重试失败做指数退避重试（5s/30s/2m/10m），达到 `max_retries` 后消息进入 `webhooker-delivery-dlq` 并标记为 dead。

### 6. 部署

```bash
bunx wrangler deploy
```

Worker 现在可通过 `https://webhooker.<your-subdomain>.workers.dev` 访问。

### 7. 配置 GitHub Webhook

1. 进入 GitHub App 设置页面
2. 设置 **Webhook URL** 为 `https://webhooker.<your-subdomain>.workers.dev/webhook`
3. 设置 **Webhook secret** 与 `GITHUB_WEBHOOK_SECRET` 一致

### 8.（可选）配置 Gitea Webhook

1. 在 Gitea 仓库中进入 **设置 → Web 钩子 → 添加 Web 钩子 → Gitea**
2. 设置 **目标 URL** 为 `https://webhooker.<your-subdomain>.workers.dev/webhook`
3. 设置 **HTTP 方法** 为 `POST`、**Content Type** 为 `application/json`
4. 设置 **密钥** 与 `GITEA_WEBHOOK_SECRET` 一致
5. 选择要触发的事件（push、议题、拉取请求、发布等）

## GitHub App 设置

### 1. 创建 App

1. 打开 <https://github.com/settings/apps/new>
2. 填写：
   - **GitHub App name**: `WebHooker`（或自定义名称）
   - **Homepage URL**: 你的域名
   - **Webhook URL**: `https://your-domain/webhook`
   - **Webhook secret**: 生成并复制到 `GITHUB_WEBHOOK_SECRET`
3. 设置权限：
   - **Repository permissions**: Contents (read)、Issues (write)、Pull requests (write)、Metadata (read)、Checks (read)、Actions (read)、Deployments (read)、Discussions (read)、Code scanning alerts (read)、Dependabot alerts (read)
   - **Organization permissions**: Members (read) —— 如果需要
4. 订阅事件（全部 28 种支持的事件）：
   - Push、Pull request、Issues、Issue comment、Workflow run、Workflow job、Status、Deployment、Deployment status、Ping、Release、Create、Delete、Star、Fork、Check run、Check suite、Pull request review、Pull request review comment、Commit comment、Member、Label、Milestone、Discussion、Discussion comment、Repository、Code scanning alert、Dependabot alert
5. 生成私钥 — 可选；设置 `GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY` 后，安装后页面会显示安装所属账号的登录名，并以安装令牌鉴权私有仓库的 API 增强（作业列表、构建日志）（见上方提示）。

### 2. 安装 App

1. 创建后，进入 App 设置页面
2. 点击 "Install App" → 选择组织/用户
3. 选择要监控的仓库

### 3. 配置 OAuth

1. 进入 App → OAuth 设置
2. 设置 **Callback URL**: `https://your-domain/auth/github/callback`
3. 将 Client ID 和 Client Secret 复制到环境变量

## Discord Bot 设置

1. 打开 <https://discord.com/developers/applications>
2. 创建新应用 → 进入 Bot 部分
3. 将 Bot Token 复制到 `DISCORD_TOKEN`
4. 使用 `bot` 与 `applications.commands` 两个 scope 邀请 Bot，并勾选 `View Channels` + `Send Messages` + `Send Messages in Threads` 权限（组合整数 `274877910016`）：

   ```text
   https://discord.com/oauth2/authorize?client_id=YOUR_BOT_CLIENT_ID&permissions=274877910016&scope=bot+applications.commands
   ```

5. 在 Web UI（`/admin`）中**按路由**配置目标频道——无需全局频道 ID。

### Interactions Endpoint

消息通过 Discord **REST API** 发送，因此仅凭 `DISCORD_TOKEN` 即可推送。交互（斜杠命令、按钮、modal）则通过 HTTPS Interactions Endpoint 送达：

1. 在 Discord 开发者门户 → General Information 复制应用的 **Public Key**，填入 `DISCORD_PUBLIC_KEY`。
2. 将 **Interactions Endpoint URL** 设为 `https://your-domain/discord/interactions`。
3. 所有交互请求都使用 Ed25519 签名验证（`X-Signature-Ed25519` 覆盖 `X-Signature-Timestamp + body`）。

`/gh` 斜杠命令与 `GitHub: 添加/编辑/删除评论` 消息命令由定时任务（每 5 分钟）同步注册：按服务器即时可用，同时全局注册（24h 去重，约 1 小时传播）。Bot 从不连接 Discord Gateway，因此显示为**离线**——消息推送不受影响（始终走 REST）。

用户运行 `/gh login` 绑定自己的 GitHub 账号，即可以本人身份评论 issue/PR。完整命令说明见[机器人命令](/zh/guide/commands)。

## Telegram 机器人配置

1. 用 [@BotFather](https://t.me/BotFather) 创建机器人，将 Token 复制到 `TELEGRAM_TOKEN`。
2. （可选）设置 `TELEGRAM_WEBHOOK_SECRET`；webhook 注册时会作为 `secret_token` 传给 Telegram，`POST /telegram/webhook` 使用时间安全比较校验。
3. Worker 会在定时任务中自动同步 webhook（`setWebhook` 指向 `{BASE_URL}/telegram/webhook`），因此无需手动调用 `setWebhook`——只需确保 `BASE_URL` 已设置。
4. 将机器人加入群组（或启用话题），在路由配置中用 `chatId` / `topicId` 指定目标。

在 Telegram 中，`/gh` 命令（`/gh login`、`/gh logout`、`/gh comment <内容>`、`/gh merge`、`/gh close`）通过在通知消息上**回复**来使用——见[机器人命令](/zh/guide/commands)。

头像使用内置 `GET /api/richheader` 渲染为链接预览卡片（可用 `TELEGRAM_RICH_HEADER_HOST` 覆盖）。

## 飞书机器人配置

1. 进入[飞书开放平台](https://open.feishu.cn/app) → **创建应用** → 选择**企业自建应用** → 填写应用名称。
2. 在**凭证与基础信息**中复制 **App ID** 与 **App Secret**，分别填入 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。
3. 在**权限管理**中添加以下任一消息发送权限，用于发送（与读取）消息：
   - `im:message`（读取和发送单聊与群聊消息）
   - `im:message:send_as_bot`（以应用机器人身份发送消息）
   - `im:message:send`（旧版发送消息权限）
4. 在**机器人**功能中启用机器人。将机器人添加到目标群聊（或创建新群），并在群设置中复制 **Chat ID**。
5. 在 WebHooker `/admin` 中创建或编辑路由，添加目标：`platform: "feishu"`，`chatId` 填写飞书 **Chat ID**，子话题可填 `topicId`。

WebHooker 使用应用级凭证（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`）请求 `tenant_access_token`（有效期约 2 小时），缓存到期前复用，并以**卡片消息**（`interactive`）形式发送。`workflow_run` / `check_run` 的进度更新同样会调用飞书消息编辑接口，原地更新消息。

### 入站：指令与按钮

与 Discord、Telegram 一样，WebHooker 可接收飞书事件，让用户直接在聊天里操作 PR/Issue：

- `/gh login` —— 绑定 GitHub 账号（打开 OAuth 页面）。
- `/gh logout` —— 解绑 GitHub 账号。
- `/gh comment <PR/Issue 链接> <内容>` —— 以绑定的 GitHub 身份发表评论。
- `/gh merge <PR 链接>` / `/gh close <PR 链接>` —— 以绑定身份合并 / 关闭 PR。
- 卡片上的 **合并** / **关闭** 按钮触发相同操作。

开启入站：

1. 在应用的**事件订阅**中，把**请求地址**设为 `https://<你的-worker>/feishu/webhook`（飞书会发送 `url_verification` 校验，WebHooker 自动应答）。
2. 订阅以下事件：
   - `im.message.receive_v1` —— 接收 `/gh` 指令（依赖 `im:message` 权限）。
   - `card.action.trigger` —— 接收卡片按钮点击。
3. **凭证与基础信息**中的 **App Secret**（即 `FEISHU_APP_SECRET`）同时用于对入站回调做 `X-Lark-Signature` 签名，WebHooker 会校验它。

### 所需权限

| 权限                     | 用途                                              |
| ------------------------ | ------------------------------------------------- |
| `im:message`             | 读取和发送单聊与群聊消息。                        |
| `im:message:send_as_bot` | 以应用机器人身份发送消息（`im:message` 的替代）。 |
| `im:message:send`        | 旧版发送消息权限（`im:message` 的替代）。         |

> [!NOTE]
> 不支持“自定义机器人”的群级 Webhook URL。WebHooker 统一使用**应用机器人**，以保持与 Discord、Telegram 一致的凭证管理、消息编辑、多群路由与入站指令能力。

## 自定义域名（可选）

要使用自定义域名替代 `*.workers.dev`：

1. 进入 Cloudflare Worker 设置
2. 添加自定义域名或路由
3. 更新 `BASE_URL` 以匹配

> [!NOTE]
> 本项目是一个 Cloudflare Worker，依赖 `wrangler.jsonc` 中声明的 KV 与 D1 绑定，无法作为独立的 Node/容器进程运行。Queues 绑定（`QUEUE`）可选——未绑定时 webhook 分发保持内联同步。
