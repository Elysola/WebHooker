# Routes & Targets

Routes define which events get forwarded to which channel (Discord or Telegram). They are stored in D1 (`d1_routes`, seeded from the legacy KV `config:routes` key on first load), managed via the [Web UI](./configuration#web-ui), the [Admin API](../api/admin), or `config.example.yaml`.

There are **no default routes** — each route must define its own target. If no routes are configured, no events are forwarded. At most **200 routes** can be saved per instance.

## Route Schema

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

Each entry of `targets` is a push destination, so one route can forward to several channels at once (e.g. a Discord channel **and** a Telegram group). `target.platform` selects the platform: `discord` (default), `telegram` or `feishu`. For **Discord**, `target.channelId` is required (a thread in `target.threadId` is optional). For **Telegram** and **Feishu**, `target.chatId` (the group/supergroup chat id, e.g. `-1001234567890`) is required and `target.topicId` (the `message_thread_id` of a topic, equivalent of a Discord thread) is optional. There is no fallback to a default channel.

| Field            | Type     | Required | Description                                                                                                       |
| ---------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `groupId`        | string   | Yes      | Id of the [group](./groups) this route belongs to                                                                 |
| `fallback`       | boolean  | No       | When `true`, fires only if no non-fallback route matched the event; its own filters are ignored                   |
| `stop`           | boolean  | No       | When `true` and this route matches, no further routes are evaluated for this event                                |
| `discordRoleIds` | string[] | No       | Discord role ids to ping when this route fires; applied to Discord targets only                                   |
| `ast`            | object   | No       | Boolean filter tree (`{all:[...]}` / `{any:[...]}` / `{not:{...}}`); takes precedence over `filters` when present |

## Route Order

Routes are evaluated in the order the console shows them, group by group. To change it, click **Reorder** on the group page, drag routes by their handle (or focus a handle and press <kbd>↑</kbd> / <kbd>↓</kbd>), then **Save order**. The order is stored per group in D1 (`d1_routes.position`, migration `0012`); a database without that migration keeps loading routes in id order.

## Discord Role Mentions

Set `discordRoleIds` on a route to ping one or more Discord roles (身份组) whenever that route fires. The mention (`<@&roleId>`) is prepended to the message content of every **Discord** target of the route; Telegram targets ignore this field. Mentions only trigger notifications when the bot has the `Mention Everyone` permission (or the role is marked mentionable), and the bot must be able to see the role.

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

You can add role ids in the admin console under _Discord role mentions_.

## Filters

Every route carries a `filters` array (all must match — AND logic). When the route has an `ast` field (a nested `all`/`any`/`not` tree), it is evaluated instead of `filters`, so it can express arbitrary boolean combinations. See the [Filter Types](./configuration#filter-types) reference and the [Filter Tutorial](./filters).

## Custom Route Example

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
