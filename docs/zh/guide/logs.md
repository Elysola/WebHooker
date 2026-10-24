# 日志

## 发送日志（`send_logs`）

每次分发尝试都会记录到 D1 `send_logs` 表，并可在控制台（**日志**标签页）查看。字段：

| 字段         | 含义                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `routeId`    | 匹配的路由                                                                                                  |
| `groupId`    | 路由所属分组                                                                                                |
| `event`      | 事件类型（如 `push`、`pull_request`、`custom`）                                                             |
| `repo`       | 仓库全名（存在时）                                                                                          |
| `target`     | 消息发送到的目标 id                                                                                         |
| `platform`   | `discord`、`telegram` 或 `feishu`                                                                           |
| `ok`         | 发送是否成功                                                                                                |
| `status`     | 平台 API 的 HTTP 状态码（适用时）                                                                           |
| `error`      | 失败时的错误信息                                                                                            |
| `errorCode`  | 稳定错误码（如 `NO_TARGET`、`NO_TOKEN`、`RATE_LIMITED`、`FORMAT`、`PAYLOAD_MISSING`、`TELEGRAM_UNCERTAIN`） |
| `attempts`   | 含重试在内的发送次数                                                                                        |
| `durationMs` | 发送耗时                                                                                                    |
| `deliveryId` | Webhook 投递 id（提供时）                                                                                   |
| `messageId`  | 平台消息 id（用于原地编辑）                                                                                 |
| `actor`      | 发送者登录名                                                                                                |
| `action`     | 事件动作（存在时）                                                                                          |
| `detail`     | 附加 JSON 详情（存在时）                                                                                    |

控制台的**日志**标签页列出最近记录（可按分组过滤），并可查看单条完整详情。写入为尽力而为——插入失败会重试一次，且不会中断分发。`send_logs` 不会自动清理。

需要留意的错误码：

- `PAYLOAD_MISSING` —— 排队投递暂存的负载已丢失；投递保持重试状态，该记录提示从源头重新投递 webhook。
- `TELEGRAM_UNCERTAIN` —— Telegram 返回 `200` 但响应无法读取；消息可能已发出也可能没有，因此不会重试（Telegram 没有幂等键）。
- `FORMAT` —— 事件无法格式化；该路由没有发送任何内容。

## 审计日志（`audit_logs`）

所有管理员操作都会记录到 D1 `audit_logs` 表，并可在控制台（**审计**标签页）查看：登录/登出、分组/路由/成员/邀请变更、Token 撤销、安装绑定等。字段：时间戳、操作者（GitHub id + 登录名）、动作、目标类型/id、分组 id、IP 与详情 JSON。

记录由定时任务在 `AUDIT_RETENTION_DAYS`（默认 90）后自动清理。与发送日志一样，写入为尽力而为。

## Webhook 日志频道

分组还可以在 Discord 频道/子区或 Telegram 群组/话题中接收每条 webhook 的摘要消息——见[分组 → Webhook 日志频道](./groups#webhook-日志频道)。这些摘要是尽力发送的，**不会**记录到 `send_logs`。
