# 配置

本页是密钥与 Web 控制台的参考。核心概念在独立页面中说明：

| 主题                                        | 页面                                                    |
| ------------------------------------------- | ------------------------------------------------------- |
| 路由、目标、`fallback` / `stop`、身份组提醒 | [路由与目标](./routes)                                  |
| 分组、角色、邀请、自助注册、日志频道        | [分组与访问控制](./groups)                              |
| Webhook 提供方、分组入口、自定义 webhook    | [Webhook 接入与租户隔离](./ingress)                     |
| KV / D1 键布局                              | [存储布局](./storage)                                   |
| 过滤器（模式语法参考）                      | 下方[过滤器类型](#过滤器类型) / [过滤器教程](./filters) |

## 密钥

WebHooker 的运行需要若干密钥。本地开发时放入 `.dev.vars`，生产环境使用 Cloudflare Worker Secrets。

### 必需密钥

| 变量                    | 说明                                                        |
| ----------------------- | ----------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET` | GitHub App 设置中的 webhook 密钥                            |
| `GITEA_WEBHOOK_SECRET`  | Gitea 实例的 webhook 密钥（仅接收 Gitea webhook 时需要）    |
| `GITHUB_CLIENT_ID`      | App 设置中的 OAuth 客户端 ID                                |
| `GITHUB_CLIENT_SECRET`  | App 设置中的 OAuth 客户端密钥                               |
| `DISCORD_TOKEN`         | Discord 机器人 Token                                        |
| `TELEGRAM_TOKEN`        | Telegram 机器人 Token（BotFather 获取）—— Telegram 路由必需 |
| `FEISHU_APP_ID`         | 飞书应用 ID（应用凭证页获取）—— 飞书路由必需                |
| `FEISHU_APP_SECRET`     | 飞书应用密钥 —— 飞书路由必需                                |

> [!NOTE]
> `GITHUB_APP_ID` 与 `GITHUB_PRIVATE_KEY`（PKCS#8 PEM）用于 GitHub App **安装流程**
> （`/auth/github/install`），通过 App JWT 解析安装所属账号的登录名。两者均为可选——
> 未设置时安装页仍可正常使用，但会显示无账号名的匿名 `inst-{installationId}` 分组。
> OAuth 流程本身只需要 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`。

### 可选密钥

| 变量                        | 说明                                                                                           | 默认值                  |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------- |
| `DISCORD_PUBLIC_KEY`        | Discord 应用的公钥（开发者门户获取），交互功能必需                                             | 未设置时交互返回 401    |
| `DISCORD_APPLICATION_ID`    | Discord 应用 ID；省略时自动获取                                                                | 自动获取                |
| `TELEGRAM_WEBHOOK_SECRET`   | `POST /telegram/webhook` 验签密钥（X-Telegram-Bot-Api-Secret-Token）                           | 未设置时不校验          |
| `TELEGRAM_RICH_HEADER_HOST` | 外部 rich-header 服务的基础 URL；未设置时使用内置 `GET /api/richheader` 提供 Telegram 头像卡片 | 内置 `/api/richheader`  |
| `BASE_URL`                  | OAuth 回调的公共 URL                                                                           | `http://localhost:8787` |
| `ADMIN_USER_IDS`            | 允许访问 WebUI 的 GitHub 用户 ID（或登录名），逗号分隔                                         | 未设置时 WebUI 关闭     |
| `DEBUG_MODE`                | 仅本地开发：精确设为 `true` 时跳过全部 `/admin` 身份验证并授予完整权限                         | 关闭                    |
| `ALLOW_SELF_SIGNUP`         | 开启（`1`/`true`）后，没有任何分组权限的 GitHub 用户首次登录会自动获得个人分组而非 403         | 关闭                    |
| `AUDIT_RETENTION_DAYS`      | 定时清理时审计日志的保留天数                                                                   | `90`                    |
| `NUXT_PUBLIC_DOCS_URL`      | 落地页使用的文档站 URL（客户端运行时配置）                                                     | 落地页默认值            |
| `NUXT_PUBLIC_REPO_URL`      | 落地页使用的 GitHub 仓库 URL                                                                   | 落地页默认值            |
| `NUXT_PUBLIC_LEGAL_CONTACT` | `/terms` 与 `/privacy` 页面展示的联系方式                                                      | 未设置时显示占位文本    |

## Web 控制台

WebHooker 在 `/admin` 提供内置配置控制台，可在浏览器中管理路由、分组、成员、邀请、发送日志与审计日志。它由 GitHub OAuth 与管理员白名单保护。

### 设置

1. 配置 `ADMIN_USER_IDS`，填写允许管理一切的 GitHub 用户 ID，也支持登录名，例如 `ADMIN_USER_IDS=12345,RhenCloud`。未设置时控制台禁用（除非开启 `ALLOW_SELF_SIGNUP`）。
2. 打开 `/admin` 并使用 GitHub 登录。
3. 没有任何访问权限的用户会得到 `403`，除非 `ALLOW_SELF_SIGNUP=1`（获得个人分组）或跟随分组[邀请链接](./groups#邀请)。

仅供本地调试：设置 `DEBUG_MODE=true` 可跳过 GitHub OAuth，并授予完整控制台权限。部署环境切勿设置此变量。

控制台以 SPA 形式在 `/admin` 提供；其标签页可通过 URL 路径直达（`/admin/groups`、`/admin/logs`、`/admin/audit`），每个分组的路由页也有独立 URL（`/admin/groups/{groupId}`）。各页面都会记入浏览器历史：从分组返回分组列表请使用浏览器（或设备）自带的返回；若页面上有打开的编辑器或未保存的路由顺序，离开前会先确认。未知的控制台路径显示控制台的 404 页面。`/admin` 之外未匹配到端点的 URL 直接返回 `404`，而不会展示控制台。

删除类操作——删除路由、分组、过滤条件、片段、目标或来源主机，移除成员，撤销邀请，停用分组 webhook——都会先弹出应用内确认框（从未填写过的空行直接删除）。路由与分组编辑弹窗点击遮罩不会关闭，避免丢失未保存的内容；请用「取消」、✕ 或 <kbd>Esc</kbd> 关闭。

所有管理端点（`/admin/api/*`）见 [Admin API](../api/admin)。保存的路由和分组会立即持久化到 D1（`d1_routes` / `d1_groups`），并使 KV 缓存失效、刷新配置缓存，下一次 webhook 处理即会生效。

## 过滤器类型

实操指南见[过滤器教程](./filters)，包含完整示例。

| 类型      | 匹配对象                 | 示例                               |
| --------- | ------------------------ | ---------------------------------- |
| `event`   | GitHub 事件名称          | `push`, `pull_*`, `pull_request`   |
| `repo`    | 仓库全名                 | `org/repo`, `org/*`                |
| `actor`   | 发送者登录名             | `username`, `[bot]`, `*[bot]`      |
| `action`  | 事件操作                 | `opened`, `closed`, `published`    |
| `branch`  | 分支名称                 | `main`, `feature-?`, `/^release-/` |
| `field`   | 任意载荷字段（JSONPath） | `path: "pull_request.user.login"`  |
| `keyword` | 载荷正文中的文本         | `deploy`, `/fix\s+\d+/`            |

### 过滤器行为

- 路由中的所有过滤器必须都匹配才触发路由（AND 逻辑）
- 在任何过滤器上设置 `"exclude": true` 可反转匹配逻辑（NOT 逻辑）
- 所有过滤器类型支持相同的模式形式：纯文本、`*`/`?` **通配符**（`*` 任意长度、`?` 单字符）以及 `/正则表达式/`——均不区分大小写
- 字段过滤器（`event`/`repo`/`actor`/`action`/`branch`/`field`）的通配符匹配整个值；`keyword` 的通配符和正则搜索载荷任意位置；`keyword` 的纯文本为子串搜索
- 除 `keyword` 外的每个过滤器都可加 `op` 操作符——`eq`（默认，经典行为）、`ne`、`contains`、`startsWith`、`endsWith`、`regex`、`gt`、`gte`、`lt`、`lte`、`in`、`exists`——见[过滤器教程](./filters#操作符)
- `field` 过滤器使用点号分隔的 JSONPath `path` 定位载荷字段；数组会自动展开，任一元素匹配即满足过滤器
- 路由可将过滤器嵌套在 `ast` 节点（`all` / `any` / `not`）中，取代扁平的 `filters` 列表；存在 `ast` 时它优先
- 超过 200 个字符的模式不编译为通配符/正则；`//` 包裹的非法正则匹配不到任何内容
- `branch` 过滤器适用于 push、pull_request、pull_request_review、pull_request_review_comment、create/delete、workflow_run、workflow_job、check_suite、deployment 和 code_scanning_alert 事件

### 匹配值

过滤器接受单个字符串或字符串数组：

```json
{ "type": "event", "match": "push" }
{ "type": "event", "match": ["push", "pull_request"] }
{ "type": "field", "path": "pull_request.commits", "op": "gt", "match": "1" }
```
