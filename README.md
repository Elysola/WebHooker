# WebHooker

GitHub / Gitea webhook → Discord / Telegram / Feishu dispatcher. Receives webhook events via Cloudflare Workers, applies filters, and routes formatted messages to Discord channels/threads, Telegram chats/topics, and Feishu chat cards. Forge-specific adapters live under `server/lib/providers/` (GitHub + Gitea today; GitLab etc. can be added later).

## Features

- **28 event formatters** — push, pull_request, issues, issue_comment, workflow_run, workflow_job, status, deployment, deployment_status, check_run, check_suite, ping, release, create, delete, star, fork, pull_request_review, pull_request_review_comment, commit_comment, member, label, milestone, discussion, discussion_comment, repository, code_scanning_alert, dependabot_alert (+ generic fallback, + `custom` webhooks)
- **Multi-provider webhooks** — GitHub (`X-Hub-Signature-256`) and Gitea (`X-Gitea-Signature`) share one `/webhook` endpoint; the provider is auto-detected from headers
- **Per-group webhook ingress** — every group can get its own `POST /webhook/{groupId}` URL + secret (Gitea, classic GitHub webhooks, and arbitrary custom JSON posts signed with `X-WebHooker-Signature`, with optional timestamp+nonce replay protection)
- **GitHub App tenant isolation** — bind a group to a GitHub App installation id so only that org/user's events enter it
- HMAC-SHA256 signature verification (Web Crypto API)
- Filter by event type, repo, actor, action, branch, keyword, or any payload field (`field` with a JSONPath `path`, e.g. `pull_request.user.login`); supports `*`/`?` globs and `/regex/` patterns plus 12 comparison operators (`eq`/`ne`/`contains`/`startsWith`/`endsWith`/`regex`/`gt`/`gte`/`lt`/`lte`/`in`/`exists`)
- Combine filters into a boolean AST (`all` / `any` / `not` nodes) via the route editor's visual builder; reuse named filter fragments and dry-run any filter against a pasted JSON payload without storing it
- Rich messages with color coding, author avatars, fields, and timestamps — rendered as Discord embeds and Telegram HTML
- Route to Discord channels/threads, Telegram chats/topics, and Feishu group chats (multi-target routes)
- `workflow_run` / `check_run` progress is edited **in place** (single message updated as the run advances) on Discord, Telegram, and Feishu — `check_run` tracks by check name + commit SHA so deployments that issue a fresh run id per phase (e.g. Cloudflare Pages) still edit the same message; `workflow_run` embeds a colored per-job code block (🟢 success, 🔴 failure, running/queued inline)
- **Per-group webhook log channel** — point a group at a Discord channel/thread, Telegram chat/topic, or Feishu chat and every webhook the group's routes dispatch is summarized there (✅/❌ per route × target)
- GitHub OAuth for user actions (comment, edit comment, delete comment, merge, close, react)
- **Web UI config console** (`/admin`) — Elysola UI-based console with centered route/group dialogs; manage routes and groups with GitHub OAuth + admin whitelist, view send logs
- **Discord Interactions Endpoint** (Ed25519-verified) for `/gh` slash commands, message context-menu commands, PR merge/close buttons, and comment modals
- **Telegram `/gh` commands** (login/logout/comment/merge/close) via the Telegram webhook, with avatar link-preview cards
- Cloudflare D1 for config (routes/groups), send logs, platform account links, dedup, delivery state and message tracking + KV for ephemeral state/cache/security tokens, + optional R2 for oversized payloads
- **Async delivery via Cloudflare Queues** — when the `QUEUE` binding is present, verified webhooks are enqueued to `webhooker-delivery` and dispatched by a consumer with exponential retry backoff (5s/30s/2m/10m) and a dead-letter queue (`webhooker-delivery-dlq`); oversized payloads are parked in R2 (`PAYLOAD` binding, falling back to KV `queue:payload:*`). Without the binding, dispatch stays inline
- Graceful degradation (webhook-only mode if Discord unavailable)

## Architecture

```text
GitHub Webhook → Cloudflare Worker (Nuxt 4 / Nitro)
                  ├── POST /webhook → verify → dedup → enqueue (Queue) → dispatch → Discord (REST) / Telegram (Bot API) / Feishu (Bot API)
                 ├── POST /discord/interactions → verify (Ed25519) → handle command/button/modal
                 ├── POST /telegram/webhook → verify (secret token) → handle /gh commands
                 ├── GET  /auth/github → OAuth flow
                 ├── GET  /api/richheader → Telegram avatar link-preview card
                 ├── POST /api/* → user actions (Bearer token auth)
                 ├── /admin → routes, groups & send logs Web UI
                 └── GET  /health → status check
```

- **Cloudflare Worker** — HTTP ingress, signature verification, routing, platform dispatch
- **Interactions Endpoint** — HTTPS callback (no Discord Gateway connection, no Durable Object); the bot stays offline and commands are registered via the API
- **KV** — cache + ephemeral state: token storage (`token:{userId}`), OAuth state (`state:{hex}`), admin sessions (`session:{id}`), invites, delivery dedup/state/message-tracking **fallback** (`delivery:*`, `delivery-state:*`, `msg:*` used only when D1 is unavailable) and message-update locks (`msg:lock:*`)
- **D1** — source of truth for routes/groups (`d1_routes`/`d1_groups`, including each group's webhook secret), named filter fragments (`d1_fragments`), send logs (`send_logs`), audit logs (`audit_logs`), dedup (`dedup_keys`), delivery state (`delivery_state`), message-update tracking (`message_tracking`), Discord↔GitHub links (`discord_links`), Telegram↔GitHub links (`telegram_links`)
- **Queue** — async delivery when `QUEUE` is bound: `webhooker-delivery` (exponential retry) + DLQ `webhooker-delivery-dlq`; oversized payloads parked in R2 (`PAYLOAD` binding, `webhooks/YYYY/MM/DD/*.json`, falling back to KV `queue:payload:*`)

## Quick Start

```bash
bun install          # package manager is bun (lockfile: bun.lock)
cp .env.example .dev.vars   # Fill in secrets for local dev
bun run db:migrate   # Apply the D1 migrations to the local database (first run)
bun run cf:dev       # Build, then serve the worker locally with wrangler dev
```

## Configuration

### Secrets (`.dev.vars` for local, Worker Secrets for production)

| Variable                    | Description                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`     | Webhook secret from GitHub                                                                                                 |
| `GITEA_WEBHOOK_SECRET`      | Webhook secret from Gitea (required only to receive Gitea webhooks)                                                        |
| `GITHUB_APP_ID`             | GitHub App ID — the App install flow needs it to verify the installer (otherwise only super admins can bind installations) |
| `GITHUB_PRIVATE_KEY`        | App private key (PKCS#8 PEM) — needed together with `GITHUB_APP_ID`; also authenticates API enrichment                     |
| `GITHUB_CLIENT_ID`          | OAuth client ID                                                                                                            |
| `GITHUB_CLIENT_SECRET`      | OAuth client secret                                                                                                        |
| `DISCORD_TOKEN`             | Bot token                                                                                                                  |
| `DISCORD_PUBLIC_KEY`        | Discord application public key (from the Developer Portal) — required for interactions                                     |
| `DISCORD_APPLICATION_ID`    | Discord application id (optional; auto-resolved via `GET /oauth2/applications/@me` if omitted)                             |
| `TELEGRAM_TOKEN`            | Telegram bot token (from BotFather) — required for Telegram routes                                                         |
| `TELEGRAM_WEBHOOK_SECRET`   | Optional secret token for `POST /telegram/webhook` verification (derived from the token if unset)                          |
| `TELEGRAM_RICH_HEADER_HOST` | Optional base URL overriding the built-in `GET /api/richheader` for Telegram avatar cards                                  |
| `FEISHU_APP_ID`             | Feishu app ID (from the app Credentials page) — required for Feishu routes                                                 |
| `FEISHU_APP_SECRET`         | Feishu app secret — required for Feishu routes                                                                             |
| `FEISHU_ENCRYPT_KEY`        | Feishu event Encrypt Key (signature check + decryption) — this or the token below is required for inbound Feishu commands  |
| `FEISHU_VERIFICATION_TOKEN` | Feishu event Verification Token, checked on every inbound callback                                                         |
| `BASE_URL`                  | Public URL for OAuth callbacks and the Telegram webhook sync                                                               |
| `ADMIN_USER_IDS`            | Comma-separated GitHub user IDs (or logins; numeric ids recommended) of super admins                                       |
| `DEBUG_MODE`                | Local development only: set to exact `true` to bypass all `/admin` authentication                                          |
| `ALLOW_SELF_SIGNUP`         | `1` to give access-less GitHub users a personal group on first login (default off)                                         |
| `AUDIT_RETENTION_DAYS`      | Audit-log retention in days for the scheduled cleanup (default 90)                                                         |
| `NUXT_PUBLIC_DOCS_URL`      | Optional docs site URL used by the landing page                                                                            |
| `NUXT_PUBLIC_REPO_URL`      | Optional GitHub repo URL used by the landing page                                                                          |
| `NUXT_PUBLIC_LEGAL_CONTACT` | Optional contact shown on `/terms` and `/privacy`                                                                          |

### Routes

Routes are stored in D1 (`d1_routes`, seeded from legacy KV `config:routes` on first load). There are **no default routes** — every route (including its target) must be defined explicitly, via the Web UI (`/admin`) or the Admin API. A route may carry multiple `targets`, so one rule can forward to several channels at once:

```json
[
  {
    "id": "all-push",
    "name": "Push Events",
    "enabled": true,
    "groupId": "default",
    "filters": [{ "type": "event", "match": "push" }],
    "stop": true,
    "targets": [
      { "platform": "discord", "channelId": "CHANNEL_ID" },
      { "platform": "telegram", "chatId": "-1001234567890" },
      { "platform": "feishu", "chatId": "oc_xxx" }
    ]
  }
]
```

`target.platform` selects the push target: `discord` (default), `telegram`, or `feishu`. Discord targets require `target.channelId` (optional `threadId` for a thread); Telegram targets require a numeric `target.chatId` (optional `topicId` for a topic); Feishu targets require `target.chatId` (`oc_…`; no topics). A route may also set `stop: true` (skip later routes of its group). Routes belong to **groups** (D1 `d1_groups`, seeded from legacy KV `config:groups`) that scope admin access and can restrict which org/user events flow in. See the [Routes & Targets](https://webhooker.docs.elysola.org/guide/routes) and [Groups & Access Control](https://webhooker.docs.elysola.org/guide/groups) guides for the full schema.

### Web UI (`/admin`)

The built-in config console lets you manage routes and groups in the browser (add / edit / delete / toggle / drag to reorder — the saved order is the evaluation order), inspect send logs, manage group members and invite links, and read the audit log — no KV access needed:

1. Set `ADMIN_USER_IDS` to the GitHub user IDs (or logins) allowed to manage the console, e.g. `ADMIN_USER_IDS=12345,RhenCloud`.
2. Visit `/admin` and sign in with GitHub. Users with no access get `403` — unless `ALLOW_SELF_SIGNUP=1` (they receive a personal group) or they follow a group invite link.
3. Changes are written to D1 immediately, the config cache is invalidated, and the webhook pipeline picks them up on the next run.

For local-only debugging, `DEBUG_MODE=true` bypasses GitHub OAuth and grants full console access. Never set it in a deployed environment.

Sign out at `/admin/logout`. Every group has `members` with a role (`owner` / `admin` / `viewer`); all admin operations are recorded in the D1 `audit_logs` table.

### Filter Types

Every filter supports plain text, `*`/`?` globs, and `/regex/` patterns (case-insensitive); set `exclude: true` to invert. A `field` filter reads any payload value by JSONPath (arrays expand so any element matches) and accepts an `op` operator (default `eq`); `op: "exists"` checks presence without a `match`. Filters can also be grouped into an AST via an optional `ast` on a route (`all` / `any` / `not` nodes) to express boolean combinations beyond the default AND-list — when present, `ast` takes precedence over `filters`. The route editor provides a visual AST builder, chip multi-value input, a stateless match tester, and named filter fragments (stored in D1 `d1_fragments`). See the [Filter Tutorial](https://webhooker.docs.elysola.org/guide/filters) for the pattern syntax and the full filter reference.

## API

### Health

- `GET /health` — Returns `{"status": "ok"}`

### OAuth

- `GET /auth/github` — Start GitHub OAuth flow (redirects to GitHub)
- `GET /auth/github/callback` — OAuth callback (exchanges code for token; admin session / Discord link / Telegram link)
- `DELETE /auth/token/:userId` — Revoke user token

### Actions (require `Authorization: Bearer <token>` header)

- `POST /api/comment` — Create issue comment
- `POST /api/merge` — Merge pull request
- `POST /api/close` — Close pull request
- `POST /api/react` — Add reaction to issue

### Admin (require admin OAuth session)

- `GET /admin` — Config console UI
- `GET /admin/login` — Start admin sign-in (GitHub OAuth)
- `GET /admin/logout` — Sign out
- `GET /admin/invite?token=…` — Accept a group invite (browser page)
- `GET /admin/api/routes` — List routes
- `PUT /admin/api/routes` — Replace routes (owner/admin per group)
- `GET /admin/api/groups` — List groups + your role in each
- `PUT /admin/api/groups` — Replace groups (super: all; owner: own groups only)
- `GET /admin/api/groups/:groupId/routes` — List a group's routes
- `PUT /admin/api/groups/:groupId/routes` — Replace a group's routes
- `POST /admin/api/groups/:groupId/invites` — Create invite link (owner)
- `GET /admin/api/groups/:groupId/invites` — List pending invites (owner)
- `DELETE /admin/api/invites/:token` — Revoke an invite (owner)
- `GET /admin/api/audit` — Audit log (scoped)
- `GET /admin/api/me` — Current session / scope / roles
- `GET /admin/api/logs` — Send logs (scoped)
- `GET /admin/api/logs/:id` — Single send-log entry
- `GET /admin/api/metrics` — Delivery stats (totals, failure rate, per-platform/event/status, recent failures); optional `?groupId=` scope
- `GET /admin/api/delivery/:deliveryId` — All send-log attempts for one delivery

## Setup Guides

- **GitHub App** — create the app, subscribe to events, configure OAuth, and set the _Setup URL_ for tenant isolation: see [GitHub App Setup](https://webhooker.docs.elysola.org/guide/deployment#github-app-setup)
- **Discord bot** — create the bot, invite it with `applications.commands` (combined permission integer `274877910016`), and configure the Interactions Endpoint: see [Discord Bot Setup](https://webhooker.docs.elysola.org/guide/deployment#discord-bot-setup). The bot never connects to the Discord Gateway, so it shows as **offline** — messaging is unaffected (always REST).
- **Telegram bot** — create the bot with [@BotFather](https://t.me/BotFather), set `TELEGRAM_TOKEN` (optional `TELEGRAM_WEBHOOK_SECRET`); the webhook is synced automatically by the scheduled trigger: see [Telegram Bot Setup](https://webhooker.docs.elysola.org/guide/deployment#telegram-bot-setup)
- **Feishu bot** — create a custom app, enable the bot, add it to the target group, and set `FEISHU_APP_ID` + `FEISHU_APP_SECRET`: see [Feishu Bot Setup](https://webhooker.docs.elysola.org/guide/deployment#feishu-bot-setup)
- **Deployment** — KV namespace, D1 database + migrations, optional Queues, secrets, and deploy: see the [Deployment guide](https://webhooker.docs.elysola.org/guide/deployment)

### Bot Commands (comment on GitHub as yourself)

The bot registers native **slash** and **message context-menu** commands, synced by the scheduled trigger (every 5 minutes): per-guild for instant availability, and globally (~1h propagation); both are re-registered when the command definitions change. After `/gh login` you can comment on issues/PRs as yourself, edit/delete your comments, and merge/close PRs via buttons — all replies are ephemeral and GitHub enforces permission.

```
/gh login  /gh logout
/gh comment add|edit|del  link:<url>      (or right-click a notification → Apps → GitHub: 添加/编辑/删除评论)
```

See the full reference in the [Bot Commands guide](https://webhooker.docs.elysola.org/guide/commands).

## Development

```bash
bun run dev           # Nuxt dev server (HMR)
bun run typecheck     # Type checking
bun run lint          # ESLint
bun test              # Unit tests
```

## Supported Events

28 event formatters (push, pull_request, issues, workflow_run, release, ...) plus `custom` webhooks; unsupported events fall back to a generic formatter. See the full table with embed highlights in [Supported Events](https://webhooker.docs.elysola.org/events/supported).

## License

MIT
