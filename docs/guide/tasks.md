# Scheduled Tasks

WebHooker runs four maintenance tasks on the scheduled trigger (`*/5 * * * *`, every 5 minutes). They only run on the deployed worker (Cloudflare cron); local `wrangler dev` runs them when triggered via `wrangler dev --test-scheduled`.

| Task            | Purpose                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discord-sync`  | Registers the Discord slash/context-menu commands per guild (instant; at most 30 API calls per run, resuming where the last run stopped) and globally (~1h propagation); registered again when the command definitions change |
| `telegram-sync` | Calls `setWebhook` to `{BASE_URL}/telegram/webhook` with `TELEGRAM_WEBHOOK_SECRET` (or a secret derived from `TELEGRAM_TOKEN`) as `secret_token` — only when the registration changed, and once a day                         |
| `audit-prune`   | Deletes `audit_logs` entries older than `AUDIT_RETENTION_DAYS` (default 90)                                                                                                                                                   |
| `storage-prune` | Deletes expired `dedup_keys` rows, `delivery_state` rows older than 7 days, `message_tracking` rows older than 30 days and orphaned R2 payloads                                                                               |

There is nothing to configure beyond the secrets the tasks use (`DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `TELEGRAM_TOKEN`, `BASE_URL`, `AUDIT_RETENTION_DAYS`).
