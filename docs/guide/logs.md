# Logs

## Send Logs (`send_logs`)

Every dispatch attempt is recorded in the D1 `send_logs` table and browsable in the console (**Logs** tab). Fields:

| Field        | Meaning                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `routeId`    | Route that matched                                                                                                  |
| `groupId`    | Route's group                                                                                                       |
| `event`      | Event type (e.g. `push`, `pull_request`, `custom`)                                                                  |
| `repo`       | Repository full name (when present)                                                                                 |
| `target`     | Target id the message was sent to                                                                                   |
| `platform`   | `discord`, `telegram` or `feishu`                                                                                   |
| `ok`         | Whether the send succeeded                                                                                          |
| `status`     | HTTP status from the platform API (when applicable)                                                                 |
| `error`      | Error message (when failed)                                                                                         |
| `errorCode`  | Stable error code (e.g. `NO_TARGET`, `NO_TOKEN`, `RATE_LIMITED`, `FORMAT`, `PAYLOAD_MISSING`, `TELEGRAM_UNCERTAIN`) |
| `attempts`   | Send attempts including retries                                                                                     |
| `durationMs` | Time spent sending                                                                                                  |
| `deliveryId` | Webhook delivery id (when provided)                                                                                 |
| `messageId`  | Platform message id (used for in-place edits)                                                                       |
| `actor`      | Sender login                                                                                                        |
| `action`     | Event action (when present)                                                                                         |
| `detail`     | Extra JSON details (when present)                                                                                   |

The console's **Logs** tab lists recent entries (filterable by group) and shows full details for a single entry. Entries are written best-effort — a failed insert is retried once and never breaks dispatch. `send_logs` is not pruned automatically.

Notable error codes:

- `PAYLOAD_MISSING` — the parked payload of a queued delivery is gone; the delivery stays retrying and the entry asks for the webhook to be redelivered from its source.
- `TELEGRAM_UNCERTAIN` — Telegram answered `200` but the response could not be read; the message may or may not have been sent, so it is not retried (Telegram offers no idempotency key).
- `FORMAT` — the event could not be formatted; nothing was sent for that route.

## Audit Log (`audit_logs`)

Every admin operation is recorded in D1 `audit_logs` and browsable in the console (**Audit** tab): logins/logouts, group/route/member/invite changes, token revocations, installation bindings. Fields: timestamp, actor (GitHub id + login), action, target type/id, group id, ip, and detail JSON.

Entries are pruned automatically by the scheduled trigger after `AUDIT_RETENTION_DAYS` (default 90). Like send logs, writes are best-effort.

## Webhook Log Channel

Groups can additionally receive a per-webhook summary message in a Discord channel/thread or Telegram chat/topic — see [Groups → Webhook Log Channel](./groups#webhook-log-channel). These summaries are best-effort and are **not** recorded in `send_logs`.
