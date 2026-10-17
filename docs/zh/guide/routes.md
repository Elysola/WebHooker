# 路由与目标

路由决定哪些事件被转发到哪个频道（Discord 或 Telegram）。它们存储在 D1（`d1_routes`，首次加载时从旧版 KV `config:routes` 键同步），可通过 [Web 控制台](./configuration#web-控制台)、[Admin API](../api/admin) 或 `config.example.yaml` 管理。

**没有默认路由**——每条路由都必须定义自己的目标。未配置任何路由时不会转发任何事件。每个实例最多可保存 **200 条路由**。

## 路由模式

```json
{
  "id": "unique-route-id",
  "name": "Human-readable name",
  "enabled": true,
  "groupId": "my-group",
  "fallback": false,
  "stop": false,
  "discordRoleIds": ["111111111111111111"],
  "filters": [
    { "type": "event", "match": "push" },
    { "type": "repo", "match": "org/repo", "exclude": false }
  ],
  "targets": [
    {
      "platform": "discord",
      "channelId": "REQUIRED_CHANNEL_ID",
      "threadId": "OPTIONAL_THREAD_ID"
    }
  ]
}
```

`targets` 的每一项都是一个推送目标，因此一条路由可同时转发到多个频道（例如一个 Discord 频道**和**一个 Telegram 群组）。`target.platform` 选择平台：`discord`（默认）、`telegram` 或 `feishu`。**Discord** 目标要求 `target.channelId`（可选 `target.threadId` 指定子区）；**Telegram** 与 **飞书** 目标要求 `target.chatId`（群组/超级群组 id，如 `-1001234567890`），可选 `target.topicId`（话题的 `message_thread_id`，相当于 Discord 子区）。没有默认频道回退。

| 字段             | 类型     | 必需 | 说明                                                                                  |
| ---------------- | -------- | ---- | ------------------------------------------------------------------------------------- |
| `groupId`        | string   | 是   | 路由所属[分组](./groups)的 id                                                         |
| `fallback`       | boolean  | 否   | 为 `true` 时仅在本分组没有其他非 fallback 路由匹配时才触发；其过滤器仍会生效          |
| `stop`           | boolean  | 否   | 为 `true` 且该路由匹配时，不再评估本分组的后续路由                                    |
| `discordRoleIds` | string[] | 否   | 路由触发时要提醒的 Discord 身份组 id；仅对 Discord 目标生效                           |
| `ast`            | object   | 否   | 布尔过滤器树（`{all:[...]}` / `{any:[...]}` / `{not:{...}}`）；存在时优先于 `filters` |

## 路由顺序

路由按控制台中显示的顺序逐个分组评估。`stop` 与 `fallback` 只在分组内生效：匹配的 `stop` 路由只跳过本分组的后续路由；只有本分组的普通路由匹配时，本分组的兜底路由才不发送——一个分组永远不会屏蔽另一个分组。在分组页点击**调整顺序**，拖动路由左侧的手柄（或聚焦手柄后按 <kbd>↑</kbd> / <kbd>↓</kbd>），再点击**保存顺序**。顺序按分组保存在 D1（`d1_routes.position`，迁移 `0012`）；未执行该迁移的数据库会继续按 id 顺序加载路由。

**升级提示：** 如果现有配置依赖某个分组的 `stop` 阻止其他分组的路由执行，或依赖某个分组的普通路由匹配来抑制其他分组的兜底路由发送，请在升级时检查现有路由。这些行为现在仅在同一分组内生效，因此其他分组的路由可能开始发送消息。请将需要共同排他的路由移至同一分组，再检查它们的顺序及 `stop` / `fallback` 设置。

## Discord 身份组提醒

在路由上设置 `discordRoleIds` 可在其触发时提醒一个或多个 Discord 身份组（角色）。提醒（`<@&roleId>`）会加在路由所有 **Discord** 目标的消息内容前；Telegram 目标忽略该字段。只有当机器人拥有 `Mention Everyone` 权限（或身份组标记为可提及）且能看到该身份组时，提醒才会触发通知。

```json
{
  "id": "release-notify",
  "name": "Notify on Release",
  "enabled": true,
  "groupId": "default",
  "discordRoleIds": ["111111111111111111", "222222222222222222"],
  "filters": [{ "type": "event", "match": "release" }],
  "targets": [{ "platform": "discord", "channelId": "REQUIRED_CHANNEL_ID" }]
}
```

也可以在管理控制台的 _Discord 身份组提醒_ 中填写身份组 id。

## 过滤器

每条路由携带 `filters` 数组（全部匹配才触发——AND 逻辑）。当路由带 `ast` 字段（嵌套的 `all`/`any`/`not` 树）时，用它替代 `filters` 求值，从而表达任意的布尔组合。见[过滤器类型](./configuration#过滤器类型)参考与[过滤器教程](./filters)。

## 自定义路由示例

```json
[
  {
    "id": "backend-prs",
    "name": "Backend PRs",
    "enabled": true,
    "groupId": "backend-team",
    "filters": [
      { "type": "repo", "match": "myorg/backend" },
      { "type": "event", "match": "pull_request" },
      { "type": "actor", "match": "[bot]", "exclude": true }
    ],
    "targets": [
      {
        "platform": "telegram",
        "chatId": "-1001234567890",
        "topicId": "9876543210"
      }
    ]
  }
]
```
