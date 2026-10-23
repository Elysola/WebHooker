# Admin API

管理端点用于管理路由、分组、成员、邀请、webhook 密钥、发送日志与审计日志。它们需要会话 Cookie，可通过 `GET /admin/login`（GitHub OAuth）获取；登录用户必须列在 `ADMIN_USER_IDS` 中，或管理某个分组。仅限本地开发，精确设置 `DEBUG_MODE=true` 会跳过认证并授予完整权限，绝不能在部署环境启用。设置方法见[配置 → Web 控制台](../guide/configuration.md#web-控制台)。

控制台本身在 `/admin` 提供；其标签页可通过 URL 路径直达（`/admin/groups`、`/admin/logs`、`/admin/audit`）。

## 端点

| 端点                                            | 说明                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /admin`                                    | 配置控制台页面                                                                                                                       |
| `GET /admin/login`                              | 开始管理员登录（GitHub OAuth）                                                                                                       |
| `GET /admin/logout`                             | 退出登录并销毁会话                                                                                                                   |
| `GET /admin/invite?token=…`                     | 接受分组邀请（浏览器页面）                                                                                                           |
| `GET /admin/api/me`                             | 当前会话、权限范围、分组与角色                                                                                                       |
| `GET /admin/api/routes`                         | 列出路由（按权限过滤）                                                                                                               |
| `PUT /admin/api/routes`                         | 替换路由（按分组 owner/admin）                                                                                                       |
| `GET /admin/api/groups`                         | 列出分组（各带 `revision`）+ 当前用户在各分组的角色，以及整个列表的 `revision`                                                       |
| `PUT /admin/api/groups`                         | 批量写入（旧接口）：超级管理员替换全部分组，owner 修改/删除自己的；只写入有变化的分组                                                |
| `POST /admin/api/groups`                        | 创建单个分组（超级管理员）——请求体 `{ group }`；id 已存在或近期用过时返回 `409`                                                      |
| `PUT /admin/api/groups/:id`                     | 更新单个分组（owner）——请求体 `{ group }`；`revision` 过期时返回 `409`                                                               |
| `DELETE /admin/api/groups/:id`                  | 删除单个分组及其路由与片段（owner）——查询参数带上确认时的 `revision`、`routesRevision` 与 `version`；之后有任何变化时返回 `409`      |
| `GET /admin/api/groups/:id/routes`              | 列出某分组的路由，附带列表的 `revision`、分组 `version` 与 `unreadable`                                                              |
| `PUT /admin/api/groups/:id/routes`              | 替换某分组的路由（owner/admin）——提交的 `revision` 过期时返回 `409`                                                                  |
| `GET /admin/api/groups/:id/fragments`           | 列出某分组的命名过滤器片段，附带列表的 `revision`                                                                                    |
| `PUT /admin/api/groups/:id/fragments`           | 替换某分组的命名过滤器片段（owner/admin）——请求体 `{ fragments, revision? }`；`revision` 过期时返回 `409`                            |
| `PUT /admin/api/groups/:id/rename`              | 重命名分组（owner）——请求体 `{ newId, revision? }`；路由、片段与历史在同一事务中迁移，密钥与邀请随分组保留，旧 id 保留若干天不可复用 |
| `GET /admin/api/groups/:id/invites`             | 列出待处理的邀请（owner）                                                                                                            |
| `POST /admin/api/groups/:id/invites`            | 创建邀请链接（owner）——请求体 `{ role, note? }`（`role` 为 `admin` 或 `viewer`）                                                     |
| `DELETE /admin/api/invites/:token`              | 撤销邀请（owner）                                                                                                                    |
| `GET /admin/api/groups/:id/webhook`             | 分组 webhook 端点信息（owner）                                                                                                       |
| `POST /admin/api/groups/:id/webhook/regenerate` | 生成/重新生成分组 webhook secret（owner）                                                                                            |
| `DELETE /admin/api/groups/:id/webhook`          | 停用分组 webhook 入口（owner）                                                                                                       |
| `GET /admin/api/logs`                           | 可访问分组的发送日志（在 SQL 中先过滤再取 limit）                                                                                    |
| `GET /admin/api/logs/:id`                       | 单条发送日志（按权限过滤）                                                                                                           |
| `GET /admin/api/audit`                          | 可访问分组的审计日志（在 SQL 中先过滤再取 limit）                                                                                    |
| `GET /admin/api/metrics`                        | 投递统计（总计、失败率、按平台/事件/状态、最近失败）；可选 `?groupId=` 按分组过滤；所有汇总都只统计可访问的分组                      |
| `GET /admin/api/delivery/:deliveryId`           | 单次投递中属于可访问分组的发送记录；可选 `?groupId=`（两个分组的发送方可能使用相同的投递 id）                                        |
| `POST /admin/api/test-match`                    | 无状态过滤器试匹配——将过滤器节点对粘贴的 JSON 载荷求值（不存储任何事件）                                                             |

## 校验

- `PUT /admin/api/routes` — 请求体为 `{ "routes": Route[] }`；校验每条路由（id 格式、组内唯一 id、name、enabled、groupId、过滤器——必须是数组，**仅 `fallback` 路由或带有效 `ast` 时允许为空**；匹配器无法编译的模式（超过 200 个字符，或反向引用、前后瞻等 RE2 不支持的语法）会被拒绝；扁平 `filters` 只能是叶子条件（`all`/`any`/`not` 应放在 `ast` 中）；`keyword` 只支持默认的 `eq`；`exists` 可省略 `match`——可选的 `discordRoleIds`（最多 50 个数字形式的 Discord 身份组 id）、平台感知的 targets：Discord 需 `target.channelId`，Telegram / 飞书需 `target.chatId`，id 规则与重复目的地检查见[路由与目标](../guide/routes)）并持久化到 D1 `d1_routes`，只重写路由有变化的分组。非超级管理员把目标指向其他分组正在使用的频道时返回 `403`。返回 `200 { ok, count }` 或 `400 { error }` / `401 { error }` / `403 { error }`。未变更的路由跳过完整校验。路由过滤器支持 `field` 类型（指向 `payload` 的 JSONPath `path`，数组展开后任一元素匹配）与 12 个 `op` 操作符（`eq` 默认 / `ne` / `contains` / `startsWith` / `endsWith` / `regex` / `gt` / `gte` / `lt` / `lte` / `in` / `exists`）；嵌套 `ast`（`all` / `any` / `not`）存在时优先于 `filters`。
- `PUT /admin/api/groups` / `POST /admin/api/groups` / `PUT /admin/api/groups/:id` — 校验分组 id、`members`（或旧字段 `adminIds`；非空的 `members` 列表至少要有一个 `owner`）、`forgeSources`（最多 20 项，`name` 最多 50 个字符，类型 + 主机不能重复）、`providers`（`github` / `gitea` / `custom`）与 `installationId`；未知字段会被丢弃。来源隔离字段 `owners`、`installationId`、`isolated` 仅超级管理员可改：owner 写入时保留其已存储的值。新成员的登录名会用写入者的 token 解析为 GitHub user id；服务端字段（`instance`、webhook 密钥、成员 user id）客户端无法设置。
- 每次写入都会在事务内再次核对写入者的角色：在角色被撤销之前通过鉴权的请求会被拒绝（路由/片段写入返回 `409`，分组写入返回 `403`）。
- 乐观并发——API 返回的每个列表或分组都带有 `revision`。写入时把它带回（`group.revision`，或与 `routes` / `fragments` / `newId` 并列的 `revision`，或批量分组写入的列表 `revision`），若数据在加载后已被他人修改，服务端以 `409` 拒绝，而不是覆盖较新的修改。不带 `revision` 的写入照旧执行。批量分组写入中原样回传、未被编辑的分组不会被写入。
- `PUT /admin/api/groups/:id/routes` — 可选 `discardUnreadable: true`，用于替换无法读取的已存路由（否则分组含此类路由时保存会被拒绝）。
- `PUT /admin/api/routes` — 可选地提交 `revisions`（`GET /admin/api/routes` 返回的按分组映射）：原样回传、未编辑的分组不会写入，客户端从未加载的分组不会被改动，已编辑的分组必须仍处于加载时的 revision（否则 `409`）。每个分组在各自带保护的事务中写入。
- `PUT /admin/api/groups/:id/rename` — 可选 `revision`；返回 `{ ok, id, group, revision }`（改名后的分组及其新 revision）。以 `inst-` 或 `u-` 开头的 id 仅超级管理员可用。
- `DELETE /admin/api/groups/:id` — 需带上确认时看到的 `revision`、`routesRevision` 与 `version`（缺少时返回 `400`；分组、其路由或片段有变化，或含无法读取的路由时返回 `409`）。同时撤销该分组的邀请与 webhook secret，解除其发送日志与审计记录的分组归属（之后仅超级管理员可见），并在若干天内保留该 id 不可复用，避免排队中的投递落到复用该 id 的新分组。
- `POST /admin/api/groups/:id/webhook/regenerate` — 返回 `{ ok, url, secret, hasSecret }`；密钥只在这次响应中出现。
- `POST /admin/api/test-match` — 请求体 `{ "node": FilterNode | "filters": Filter[], "event"?: string, "payload": object }`；在内存中求值并返回 `{ matched, explanation }`，不持久化任何内容。
- `GET/PUT /admin/api/groups/:id/fragments` — 命名过滤器片段（`{ id, groupId, name, node }`）存储于 D1 `d1_fragments`；编辑器在插入时将片段的 `node` 内联进路由的 `ast`（匹配器从不解析片段引用）。`PUT` 全量替换该分组的片段（最多 200 个）并返回 `200 { ok, count }`。
- 上限：单次保存最多 200 条路由、每个分组最多 200 个片段，批量保存分组单次最多 100 个。

模式：见[路由与目标](../guide/routes)、[分组与访问控制](../guide/groups)。
