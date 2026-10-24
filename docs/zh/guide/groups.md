# 分组与访问控制

路由归属于分组。分组用于划分管理权限，并可限制进入其中的事件。它们存储在 D1（`d1_groups`，首次加载时从旧版 KV `config:groups` 键同步），可通过 [Web 控制台](./configuration#web-控制台)或 [Admin API](../api/admin) 管理。批量保存分组时单次最多 **100 个分组**。

## 分组模式

```json
{
  "id": "backend-team",
  "name": "Backend Team",
  "members": [
    { "login": "rhencloud", "role": "owner" },
    { "login": "octobot", "role": "admin" },
    { "login": "reader", "role": "viewer" }
  ],
  "owners": ["myorg"],
  "providers": ["github", "gitea"],
  "installationId": 12345678,
  "logTarget": { "platform": "discord", "channelId": "123456789", "threadId": "987654321" }
}
```

| 字段             | 类型     | 必需 | 说明                                                                                                                                                                                         |
| ---------------- | -------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | string   | 是   | 小写 id（`a-z0-9`、`-`）；被每条路由的 `groupId` 引用。可编辑：重命名会同步其路由、片段、历史记录、webhook secret 与待处理邀请；被删除或重命名的 id 会保留若干天不可复用                     |
| `name`           | string   | 是   | 人类可读的分组名                                                                                                                                                                             |
| `members`        | object[] | 是¹  | `{ login, role }` 条目；角色为 `owner`、`admin` 或 `viewer`。服务端会把每个条目绑定到 GitHub user id（添加成员时解析，或在其首次登录时绑定）；绑定后只匹配该账号，即使登录名易主             |
| `adminIds`       | string[] | 否   | 已废弃的旧字段；存在时视为角色为 `owner` 的 `members`                                                                                                                                        |
| `owners`         | string[] | 否   | 允许进入该分组的事件所属组织/用户登录名；空 = 全部                                                                                                                                           |
| `providers`      | string[] | 否   | 允许进入该分组的来源平台（`github`、`gitea`、`custom`）；空 = 全部                                                                                                                           |
| `installationId` | number   | 否   | 绑定到该分组的 GitHub App 安装 id；仅接受该安装的事件（空 = 全部）。仅超级管理员可改（由经过验证的安装流程设置）                                                                             |
| `isolated`       | boolean  | 否   | 隔离分组（自助注册的个人分组）只接收其自身 `/webhook/{groupId}` 入口的事件，直到超级管理员为其绑定来源（`installationId` 或 `owners`）。仅超级管理员可改                                     |
| `emoji`          | boolean  | 否   | 该分组消息是否包含表情（默认 `true`）                                                                                                                                                        |
| `forgeSources`   | object[] | 否   | 来源主机：`{ host, type, name? }` 条目（`type` 为 `github` 或 `gitea`，`name` 为可选显示名称），用于标注该分组消息底部；空 = 不标注                                                          |
| `lang`           | string   | 否   | 该分组所有路由的消息语言（如 `en`、`zh`；可通过 KV `i18n:<lang>` 自定义）——见[消息语言](./i18n)——默认 `en`                                                                                   |
| `logTarget`      | object   | 否   | Webhook 日志频道：Discord 目标 `{ platform, channelId, threadId? }`、Telegram 目标 `{ platform, chatId, topicId? }` 或飞书目标 `{ platform, chatId }`，接收该分组路由每次分发 webhook 的摘要 |

¹ 必须提供 `members` 或旧字段 `adminIds`。非空的 `members` 列表至少要有一个 `owner`；空列表也可以（这样的分组只能由超级管理员管理）。`forgeSources` 最多 20 项，每项 `name` 最多 50 个字符，不能有类型与主机都相同的两项。

## 角色

每个分组成员拥有三种角色之一。超级管理员（`ADMIN_USER_IDS`）始终绕过这些限制。

| 角色     | 查看路由/日志 | 编辑路由 | 管理成员与邀请 | 编辑分组设置     |
| -------- | ------------- | -------- | -------------- | ---------------- |
| `owner`  | ✓             | ✓        | ✓              | ✓（除 `owners`） |
| `admin`  | ✓             | ✓        | ✗              | ✗                |
| `viewer` | ✓（只读）     | ✗        | ✗              | ✗                |

## 权限模型

- **超级管理员**（`ADMIN_USER_IDS`）可查看和编辑所有分组与全部路由；只有他们能编辑分组的来源隔离字段（`owners`、`installationId`、`isolated`）——owner 保存时会保留已存储的值。
- **Owner** 管理自己分组的路由、成员、邀请、名称、id、`emoji` 与 `providers`。不能移除最后一个 owner，也不能在没有其他 owner 时降级自己。
- **Admin** 编辑自己分组内的路由并查看日志；**viewer** 只有只读控制台。
- 分组管理端点通过 `/admin/api/groups/:id/routes` 一次操作一个分组；`groupId` 强制取自路径参数。
- `owners` 列表把该分组的路由限制为这些用户或组织所拥有仓库的事件（`repository.owner.login` / `organization.login`）；要按事件触发者过滤，请使用 `actor` 过滤器。
- 所属分组已不存在的路由永远不会触发。
- 每次分组写入都是单行的比较并交换更新：两个人编辑不同分组时互不覆盖；基于过期副本对同一分组的编辑会被拒绝（`409`，控制台会重新加载），而不是回滚较新的修改。路由与片段列表也按分组以同样方式处理。
- 写入提交时会再次核对角色：在操作者失去角色（或被移除）之前通过鉴权的请求，提交时会被拒绝。
- 删除分组需要带上控制台确认时看到的快照（`revision`、`routesRevision` 与分组 `version`）：确认之后新增或修改的任何内容（路由、片段、设置）都会让删除返回 `409`，而不会被一并删掉。含无法读取路由的分组不会被删除。
- 投递目标有归属：非超级管理员不能把路由或日志频道指向另一个分组已在使用的频道/群聊，除非也能编辑那个分组的路由（否则返回 `403`）。此前已被两个分组共用的频道，只在原有用途中继续有效。
- `providers` 列表限制该分组路由会分发哪个 forge（`github`、`gitea`）的事件。即使组织/用户名冲突，也可借此将 GitHub 与 Gitea 分组分开。

## Webhook 日志频道

分组可以设置 `logTarget` 指向一个 Discord 频道/子区、Telegram 群组/话题或飞书群聊。每当该分组的路由分发（dispatch）一个 webhook，就会向那里发送一条摘要消息：事件类型/动作、仓库、投递 ID，以及每条「路由 × 目标」一行的 ✅/❌ 结果（失败时附带错误信息；之前尝试中已处理的目标会如实标注；最多列出前 10 行，其余以 `+N` 汇总）。全部成功时消息为绿色，任一失败为红色，含结果未知的之前尝试时为灰色。同一投递重试得到相同结果时不会再发摘要。摘要使用分组的消息语言。日志消息尽力发送，本身不会被记入 D1 发送日志。

## 来源平台标识

分组通过 `forgeSources` 定义自己接收事件的 forge，即一组 `{ host, type, name? }` 条目（`type` 为 `github` 或 `gitea`）。该分组路由发出的每条消息都会使用**与事件来源类型匹配、且 host 与仓库 URL 主机名一致的第一条**配置作为底部标识（GitHub 事件匹配 `github.com`）。标识文本为条目的可选 `name`——未填则回退为 host——因此两个自建 Gitea 实例可以显示为「内网 Gitea」/「Git2 仓库」，同时通过各自主机名完成匹配：

```json
{
  "forgeSources": [
    { "host": "github.com", "type": "github", "name": "GitHub 主站" },
    { "host": "git1.example.com", "type": "gitea", "name": "内网 Gitea" },
    { "host": "git2.example.com", "type": "gitea" }
  ]
}
```

- **Discord** — embed 底部在仓库名旁显示标识（`内网 Gitea · acme/widget`），并以站点图标作为底部图标：GitHub 使用 `fluidicon.png`，Gitea 实例使用 `/assets/img/favicon.png`（均为 Discord 可渲染的栅格 PNG——`.ico` favicon 会被 Discord 静默忽略）。
- **Telegram** — 底部行以带超链接的标识开头（`[内网 Gitea](https://git1.example.com)`）。
- 仓库主机没有匹配条目的事件（如自定义 webhook，或仓库托管在别处）不显示标识。

该标识与 `Group.emoji` 相互独立，并跟随该分组分发的所有消息（包括工作流/检查消息的就地更新）。

## 邀请

Owner（与超级管理员）可以在分组的 _成员_ 面板创建单次使用、有效期 7 天的邀请链接。接受邀请后，用户以被邀请的角色（`admin` 或 `viewer`——绝不会是 `owner`）加入；已有 `viewer` 会被升级为 `admin`。邀请在整个有效期内存储在 KV 的 `invite:{token}` 键下；"已使用"记录与成员变更在同一个 D1 事务中提交，因此即使两人同时打开同一链接，也只能使用一次。

- 邀请属于签发它的分组 instance：之后以同一 id 新建的分组不会接受它。
- 撤销邀请会记录在 D1 中并立即生效，即使 KV 里仍有该邀请。
- 签发人不再是该分组 owner 时，邀请失效。
- 如果该登录名仍挂在一个绑定到其他 GitHub 账号的成员条目上（登录名的前任持有者），接受会因冲突失败且邀请保持可用；需 owner 先移除陈旧条目。

## 自助注册

设置 `ALLOW_SELF_SIGNUP=1` 后，没有分组权限的 GitHub 用户首次登录时会获得个人分组（`u-{userId}`，归其所有），而不是 `403`。这是完全自助式 SaaS 安装的入口；关闭它可保持控制台仅邀请制。

个人分组是**隔离的**（该字段出现前创建的 `u-<数字>` 分组同样视为隔离，除非超级管理员设置 `isolated: false`）：运营者的全局 `POST /webhook` 入口永远不会分发到它们，因此自助用户无法通过添加通配路由收到其他租户的事件。它们通过自己的[分组 webhook](./ingress) 接收事件，或接收其能证明自己管理的 GitHub App 安装的事件（安装流程会用用户本人的 GitHub token 校验）。
