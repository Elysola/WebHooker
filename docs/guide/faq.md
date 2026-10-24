# FAQ & Troubleshooting

## Why is the Discord bot showing as offline?

The bot never connects to the Discord Gateway — it always sends messages via the REST API and receives interactions through the HTTPS Interactions Endpoint. **Offline is normal** and does not affect messaging.

## My webhooks are not being forwarded

Check in order:

1. `GET /health` returns `{"status":"ok"}`.
2. The webhook URL points at `{BASE_URL}/webhook` and the secret matches `GITHUB_WEBHOOK_SECRET` / `GITEA_WEBHOOK_SECRET`.
3. At least one **enabled** route exists for the event (`event` filter), and its group accepts the sender (see `owners` / `providers` / `installationId` on the group).
4. The route has at least one target with a valid channel/chat id.
5. Look at the console **Logs** tab — every dispatch attempt is recorded with the error.

## The Discord bot does not reply to commands / buttons

- `DISCORD_PUBLIC_KEY` must be set and the **Interactions Endpoint URL** must point at `{BASE_URL}/discord/interactions`.
- The user must run `/gh login` first and the OAuth secrets (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, `BASE_URL`) must be configured.
- Slash commands sync from the scheduled trigger every 5 minutes; global registration can take ~1 hour to propagate.

## I created a tag/branch but got a "0 commits" push message

Creating a tag or an empty branch via `git push` arrives as a push event with `created: true` and no commits — since the event carries the `created` flag, it is rendered as a normal `create` message. If you still see "0 commits", the payload's `created` flag was absent (e.g. an old or non-conforming delivery).

## I deleted a branch but got a "0 commits" push message

Branch deletions via `git push --delete` arrive as push events with `deleted: true` — they are rendered as a normal delete message. If you still see "0 commits", the payload's `deleted` flag was absent (e.g. an old delivery).

## How do I point a group at its own webhook endpoint?

See [Per-group endpoint](./ingress#per-group-endpoint-post-webhook-groupid) — generate a secret from the group's **Webhook endpoint** panel (owner role), then use `POST /webhook/{groupId}` with the group secret.

## Can I run this outside Cloudflare Workers?

No — the worker requires the KV and D1 bindings declared in `wrangler.jsonc` and runs on the `cloudflare_module` Nitro preset.

## Where is data stored?

Configuration lives in D1 (`d1_routes`/`d1_groups`, cached in memory for at most 60 seconds); webhook dedup, delivery state and message-update tracking also live in D1 with KV fallback; send/audit logs and platform↔GitHub links live in D1. R2 optionally parks oversized payloads. See [Storage Layout](./storage#storage-decisions).
