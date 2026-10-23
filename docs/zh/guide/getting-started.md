# 快速开始

## 前置要求

- [Bun](https://bun.sh/) 1.x（唯一包管理器，不要使用 npm）
- [Cloudflare 账号](https://dash.cloudflare.com/)（免费套餐即可）
- [GitHub App](https://github.com/settings/apps/new)（参见 [GitHub App 设置](/zh/guide/deployment#github-app-设置)）
- Discord Bot Token（参见 [Discord Bot 设置](/zh/guide/deployment#discord-bot-设置)）

## 安装

```bash
git clone https://github.com/Elysola/WebHooker.git
cd WebHooker
bun install
```

## 本地开发

### 1. 配置密钥

复制示例环境变量文件并填入你的密钥：

```bash
cp .env.example .dev.vars
```

编辑 `.dev.vars`，填入实际值：

```bash
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
DISCORD_TOKEN=your-bot-token
DISCORD_PUBLIC_KEY=your-public-key
ADMIN_USER_IDS=your-github-id
BASE_URL=http://localhost:8787
```

::: tip
`GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` 只在 GitHub App 安装流程与 API 增强中需要：没有它们时，安装流程无法核实登录用户是否管理该安装，只有超级管理员能绑定安装（OAuth 流程本身只需要 Client ID/Secret）。目标频道在 Web UI 中按路由设置，因此不需要 `DISCORD_CHANNEL_ID`。若要在本地启用 `/gh` 命令，请在开发者门户复制 **Public Key** 填入 `DISCORD_PUBLIC_KEY`，并把 Interactions Endpoint URL 设为 `http://localhost:8787/discord/interactions`。
:::

::: warning
`.dev.vars` 已被 gitignore，包含敏感信息，请勿提交。
:::

### 2. 启动开发服务器

```bash
bun run db:migrate   # 首次运行：将 D1 迁移应用到本地数据库
bun run cf:dev       # 先构建，再用 wrangler dev（Miniflare）运行 worker
```

这会在 `http://localhost:8787` 运行构建后的 worker。未执行迁移时 worker 会拒绝服务（`D1 migrations are incomplete`）。开发界面时可改用 `bun run dev` 启动带 HMR 的 Nuxt 开发服务器（`http://localhost:3000`；其中队列消息没有消费者）。

### 3. 验证

```bash
curl http://localhost:8787/health
# → {"status":"ok"}
```

## 可用脚本

| 脚本                   | 说明                                 |
| ---------------------- | ------------------------------------ |
| `bun run dev`          | 启动 Nuxt 开发服务器 (HMR)           |
| `bun run build`        | 生产构建（cloudflare_module preset） |
| `bun run deploy`       | 应用待执行的 D1 迁移并部署           |
| `bun run typecheck`    | TypeScript 类型检查                  |
| `bun run lint`         | ESLint                               |
| `bun run lint:md`      | Markdownlint                         |
| `bun run format`       | 使用 Prettier 格式化                 |
| `bun run format:check` | 检查 Prettier 格式                   |
| `bun test`             | 单元测试                             |
| `bun run docs:dev`     | 启动文档开发服务器                   |
| `bun run docs:build`   | 构建文档站点                         |
