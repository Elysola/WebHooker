# 贡献

## 开发环境设置

```bash
git clone https://github.com/Elysola/WebHooker.git
cd WebHooker
bun install
cp .env.example .dev.vars   # 填入密钥
bun run dev                  # 启动本地开发服务器
```

## 项目结构

```text
app/                     # Vue 3 UI（Nuxt app 目录）
├── app.vue              # 根组件 (NuxtPage)
├── assets/css/main.css  # Tailwind CSS v4 入口：Elysola UI 兼容的 RGB 别名 + 专用布局类
├── pages/               # index（落地页）、terms、privacy、admin/[...slug]（控制台 SPA）
├── components/          # ConsolePage、RouteCard/Editor、GroupEditor、MembersPanel、WebhookPanel、
│                        # SendLogs、AuditLog、AppToasts、LegalLayout
├── composables/         # useI18n、useToasts、useGroups、useGroupRoutes、useLogs、useAudit、useInvites、useWebhook
├── types.ts             # 共享客户端类型 (Route、Group、Filter、...)
└── utils/legal.ts       # 服务条款/隐私政策 HTML 正文 (zh/en)
server/                  # Nitro 服务器（H3 处理器位于 server/routes/）
├── routes/              # /health、/webhook[/:groupId]、/discord/interactions、/telegram/webhook、
│                        # /auth/github*、/admin/{login,logout,invite,api/**}、/api/{comment,merge,close,react,richheader}
├── tasks/               # 定时任务 (cron */5)：discord-sync、telegram-sync、audit-prune、storage-prune
├── error-handler.ts     # JSON 错误处理器
└── lib/
    ├── types.ts         # Env、Config、Route、Filter、Group、WebhookEvent、NeutralMessage
    ├── config.ts        # 绑定 D1 配置存储，读取路由/分组（最新或缓存），从 env 构建 Config
    ├── core/
    │   └── dispatch.ts  # 平台中立分发：匹配路由 → formatEvent → getDriver().send/edit
    ├── events/          # 与提供方无关的路由匹配
    │   ├── match.ts     # matchRoute、eventOwners
    │   └── filter-ast.ts # 过滤器求值（扁平过滤器 + all/any/not AST）、extractBranch、关键词搜索、RE2 模式
    ├── providers/       # Forge webhook 提供方（验证 + 解析/归一化）
    │   ├── types.ts     # Provider 接口（matches/verify/parse）
    │   ├── index.ts     # detectProvider() 注册表（github、gitea、custom）
    │   ├── github/      # X-GitHub-Event + X-Hub-Signature-256
    │   └── gitea/       # X-Gitea-Event + X-Gitea-Signature（归一化载荷）
    ├── formatters/      # 平台中立格式化器（产出 NeutralMessage）
    │   ├── index.ts     # formatEvent：构建上下文，从注册表找到格式化器 → NeutralMessage
    │   ├── registry.ts  # eventFormatters[]：事件名 → 格式化器
    │   ├── colors.ts    # GITHUB_COLORS + WORKFLOW_CONCLUSION_EMOJI
    │   ├── helpers.ts   # emojiPrefix、T、buildMessage、commitLink/branchLink/tagLink
    │   └── *.ts         # push、pull-request、issues、comments、workflow、release、create、repo、
    │                    # check、review、commit-comment、deployment、member、label、milestone、
    │                    # discussion、repository、security、generic、ping、custom
    ├── drivers/         # 平台驱动（可插拔推送目标）
    │   ├── types.ts     # PlatformDriver 接口 + SendResult（send + edit）
    │   ├── index.ts     # getDriver() 注册表（discord + telegram + feishu）
    │   ├── discord/     # index.ts (驱动)、render.ts (NeutralMessage → embed)、
    │   │                # rest.ts、interactions.ts、commands.ts
    │   └── telegram/    # index.ts (驱动)、render.ts (NeutralMessage → Telegram HTML)、
    │                    # rest.ts (chat_id + message_thread_id)、updates.ts (webhook 验签)、
    │                    # commands.ts (/gh login|logout|comment|merge|close + 引用消息解析)
    ├── github/          # GitHub OAuth + 以用户身份操作
    │   ├── oauth.ts     # OAuth URL、回调 Token 交换、getUserOctokit、评论/合并/关闭操作
    │   └── store.ts     # KV Token CRUD + D1 discord-link/telegram-link 映射
    ├── web/             # HTTP UI/API 逻辑（由 server/routes 调用）
    │   ├── oauth.ts     # GET /auth/github、回调（管理员会话 / Discord 绑定 / Telegram 绑定 / install 绑定）
    │   ├── actions.ts   # POST /api/comment|merge|close|react (通过 KV 查找进行 Bearer Token 鉴权)
    │   ├── admin.ts     # /admin API：路由、分组、me、日志、邀请、审计（会话 + 权限范围鉴权）
    │   ├── auth.ts      # 共享鉴权中间件 + 守卫
    │   ├── invites.ts   # 邀请 CRUD + acceptInvite
    │   ├── session.ts   # 管理员会话 CRUD (KV session:{id})、Cookie 辅助函数
    │   ├── groups.ts    # 分组加载、分组管理员权限范围
    │   ├── tenants.ts   # 每分组 webhook 密钥 CRUD
    │   └── richheader.ts # GET /api/richheader（Telegram 头像卡片）
    └── lib/             # 共享基础设施
        ├── i18n.ts      # 消息语言覆盖 (en/zh)
        ├── send-log.ts  # 发送日志 (D1 send_logs)
        ├── audit.ts     # 审计日志 (D1 audit_logs)
        ├── log.ts       # JSON 控制台日志 (info/warn/error/fatal)
        └── locales/     # en.ts、zh.ts 翻译字典

tests/                   # 单元测试 (bun test)
tests/fixtures/          # 提供方负载固件 (github/gitea/custom)
tests/__snapshots__/     # 格式化器快照黄金文件
```

持续集成（`.github/workflows/ci.yml`）运行 `bun install --frozen-lockfile`、`bun test` 与
`bun run lint`。CodeQL（`codeql.yml`）与 Dependabot（`dependabot.yml`）配置在 `.github/` 下。

## 脚本

| 命令                   | 说明                          |
| ---------------------- | ----------------------------- |
| `bun run dev`          | 启动 Nuxt 开发服务器 (HMR)    |
| `bun run typecheck`    | TypeScript 类型检查           |
| `bun run lint`         | ESLint (TypeScript)           |
| `bun run lint:md`      | Markdownlint (Markdown)       |
| `bun test`             | 运行单元测试 (bun test)       |
| `bun run format`       | 使用 Prettier 格式化所有文件  |
| `bun run format:check` | 检查 Prettier 格式            |
| `bun run docs:dev`     | 启动 VitePress 文档开发服务器 |
| `bun run docs:build`   | 构建文档站点                  |

## 代码风格

- **TypeScript** 严格模式
- **双引号** 字符串
- **分号** 必需
- **尾逗号** 所有位置
- **100 字符** 打印宽度
- **ESLint** 使用 `@typescript-eslint` 推荐规则
- **Prettier** 格式化
- **Markdownlint** 用于 Markdown 文件

## 测试

```bash
# 运行单元测试套件 (bun test)
bun test

# 或手动检查健康端点
curl http://localhost:8787/health
```

除各模块单元测试外，测试套件还包含提供方固件（`tests/fixtures/` +
`tests/provider-fixtures.test.ts`）、格式化器快照（`tests/formatter-snapshot.test.ts`）以及
平台契约测试（`tests/platform-contract.test.ts`，断言 Discord/Telegram 渲染器会截断到各自的
平台限制）。

## 添加新事件格式化器

1. 将事件类型添加到 `server/lib/formatters/colors.ts` 中的 `GITHUB_COLORS`（如果需要新颜色）
2. 将操作标签添加到 `server/lib/lib/locales/en.ts` 与 `server/lib/lib/locales/zh.ts` 的翻译字典（如果有新操作）
3. 在 `server/lib/formatters/` 中创建 `formatEventType` 函数
4. 在 `server/lib/formatters/registry.ts` 的 `eventFormatters` 中注册（`{ events: ["your_event"], format: (c) => … }`）
5. 如果事件包含分支信息，更新 `server/lib/events/filter-ast.ts` 中的 `extractBranch`
6. 将事件添加到 `docs/events/supported.md` 与 `docs/zh/events/supported.md` 文档中
7. 将事件添加到 README（`README.md` 与 `README.zh.md`）的事件表与 GitHub App 事件订阅列表中
8. 在 GitHub App 设置中订阅该事件

## 拉取请求指南

- 保持变更聚焦且原子化
- 为所有函数返回值包含类型注解
- 提交前运行 `bun run typecheck && bun run lint && bun run format:check`
- 添加功能时更新文档（见 `AGENTS.md` → Documentation 的清单）：README（`README.md` / `README.zh.md`）、VitePress 文档（`docs/` 与 `docs/zh/`）以及示例配置文件
