# Configuration

This page is the reference for secrets and the Web UI. Core concepts live in dedicated pages:

| Topic                                             | Page                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| Routes, targets, `fallback` / `stop`, role pings  | [Routes & Targets](./routes)                                       |
| Groups, roles, invites, self sign-up, log channel | [Groups & Access Control](./groups)                                |
| Webhook providers, per-group ingress, custom      | [Webhook Ingress & Tenancy](./ingress)                             |
| KV / D1 key layout                                | [Storage Layout](./storage)                                        |
| Filters (pattern syntax reference)                | [Filter Types](#filter-types) below / [Filter Tutorial](./filters) |

## Secrets

WebHooker requires several secrets to function. For local development, store them in `.dev.vars`. For production, use Cloudflare Worker Secrets.

### Required Secrets

| Variable                | Description                                                                |
| ----------------------- | -------------------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret from your GitHub App settings                               |
| `GITEA_WEBHOOK_SECRET`  | Webhook secret from your Gitea instance (only to receive Gitea webhooks)   |
| `GITHUB_CLIENT_ID`      | OAuth client ID from App settings                                          |
| `GITHUB_CLIENT_SECRET`  | OAuth client secret from App settings                                      |
| `DISCORD_TOKEN`         | Discord bot token                                                          |
| `TELEGRAM_TOKEN`        | Telegram bot token (from BotFather) — required for Telegram routes         |
| `FEISHU_APP_ID`         | Feishu app ID (from the app Credentials page) — required for Feishu routes |
| `FEISHU_APP_SECRET`     | Feishu app secret — required for Feishu routes                             |

> [!NOTE]
> `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY` (PKCS#8 PEM) are used by the GitHub App
> **install flow** (`/auth/github/install`) to resolve the installing account's login
> via an App JWT. They are optional — when unset, the install page still works but
> shows an anonymous `inst-{installationId}` group without the account name. The
> OAuth flow itself only needs `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

### Optional Secrets

| Variable                    | Description                                                                                                                 | Default                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `DISCORD_PUBLIC_KEY`        | Discord application public key (Developer Portal) — required for interactions                                               | Unset → interactions return `401` |
| `DISCORD_APPLICATION_ID`    | Discord application id; auto-resolved when omitted                                                                          | Auto-resolved                     |
| `TELEGRAM_WEBHOOK_SECRET`   | Secret token for `POST /telegram/webhook` verification (X-Telegram-Bot-Api-Secret-Token)                                    | Disabled (no verification)        |
| `TELEGRAM_RICH_HEADER_HOST` | Base URL of an external rich-header service; when unset, the built-in `GET /api/richheader` serves the Telegram avatar card | Built-in `/api/richheader`        |
| `BASE_URL`                  | Public URL for OAuth callbacks                                                                                              | `http://localhost:8787`           |
| `ADMIN_USER_IDS`            | Comma-separated GitHub user IDs (or logins) allowed to access the Web UI                                                    | Disabled                          |
| `DEBUG_MODE`                | Local development only: exact `true` bypasses all `/admin` authentication and grants full access                            | Disabled                          |
| `ALLOW_SELF_SIGNUP`         | When enabled (`1`/`true`), GitHub users without any group access get a personal group on first login instead of `403`       | Disabled                          |
| `AUDIT_RETENTION_DAYS`      | Audit-log retention in days for the scheduled cleanup                                                                       | `90`                              |
| `NUXT_PUBLIC_DOCS_URL`      | Docs site URL used by the landing page (client-side runtime config)                                                         | Landing page defaults             |
| `NUXT_PUBLIC_REPO_URL`      | GitHub repo URL used by the landing page                                                                                    | Landing page defaults             |
| `NUXT_PUBLIC_LEGAL_CONTACT` | Contact shown on `/terms` and `/privacy`                                                                                    | Unset → placeholder text          |

## Web UI

WebHooker ships with a built-in config console at `/admin` for managing routes, groups, members, invites, send logs, and the audit log in the browser. It is protected by GitHub OAuth plus an admin whitelist.

### Setup

1. Configure `ADMIN_USER_IDS` with the GitHub user IDs allowed to manage everything. Logins are also accepted, e.g. `ADMIN_USER_IDS=12345,RhenCloud`. If unset, the console is disabled (unless `ALLOW_SELF_SIGNUP` is enabled).
2. Open `/admin` and sign in with GitHub.
3. Users without any access get `403`, except when `ALLOW_SELF_SIGNUP=1` (they receive a personal group) or when they follow a group [invite link](./groups#invites).

For local debugging only, set `DEBUG_MODE=true` to bypass GitHub OAuth and grant complete console access. Do not set this variable in a deployed environment.

The console is served as an SPA at `/admin`; its tabs are deep-linkable via the URL path (`/admin/groups`, `/admin/logs`, `/admin/audit`). URLs outside `/admin` that do not match an endpoint return a plain `404` instead of the console.

Destructive actions — deleting routes, groups, filter conditions, fragments, targets or forge hosts, removing members, revoking invites, disabling a group's webhook — ask for confirmation in an in-app dialog (empty, never-filled rows are removed directly).

All management endpoints (`/admin/api/*`) are documented in the [Admin API](../api/admin). Saved routes and groups are persisted to D1 (`d1_routes` / `d1_groups`) immediately, the KV cache is invalidated and the config cache is refreshed so the webhook pipeline picks them up on the next run.

## Filter Types

See the [Filter Tutorial](./filters) for a hands-on guide with worked examples.

| Type      | Matches                      | Example                            |
| --------- | ---------------------------- | ---------------------------------- |
| `event`   | GitHub event name            | `push`, `pull_*`, `pull_request`   |
| `repo`    | Repository full name         | `org/repo`, `org/*`                |
| `actor`   | Sender login                 | `username`, `[bot]`, `*[bot]`      |
| `action`  | Event action                 | `opened`, `closed`, `published`    |
| `branch`  | Branch name                  | `main`, `feature-?`, `/^release-/` |
| `field`   | Any payload field (JSONPath) | `path: "pull_request.user.login"`  |
| `keyword` | Text in payload body         | `deploy`, `/fix\s+\d+/`            |

### Filter Behavior

- All filters in a route must match for the route to trigger (AND logic)
- Set `"exclude": true` on any filter to invert it (NOT logic)
- Every filter type supports the same pattern forms: plain text, `*`/`?` **globs** (`*` = any run, `?` = one character), and `/regular expression/` — all case-insensitive
- Field filters (`event`/`repo`/`actor`/`action`/`branch`/`field`) glob-match the whole value; `keyword` globs and regexes search anywhere in the payload; plain `keyword` text is a substring search
- Every filter except `keyword` accepts an `op` operator — `eq` (default, classic behaviour), `ne`, `contains`, `startsWith`, `endsWith`, `regex`, `gt`, `gte`, `lt`, `lte`, `in`, `exists` — see the [Filter Tutorial](./filters#operators)
- `field` filters use a dot-separated JSONPath `path` into the payload; arrays are expanded so any matching element satisfies the filter
- Routes may nest filters in an `ast` node (`all` / `any` / `not`) instead of a flat `filters` list; `ast` takes precedence when present
- Patterns longer than 200 characters are not compiled as glob/regex; an invalid `//`-wrapped regex matches nothing
- `branch` filter works for push, pull_request, pull_request_review, pull_request_review_comment, create/delete, workflow_run, workflow_job, check_suite, deployment, and code_scanning_alert events

### Match Values

Filters accept either a single string or an array of strings:

```json
{ "type": "event", "match": "push" }
{ "type": "event", "match": ["push", "pull_request"] }
{ "type": "field", "path": "pull_request.commits", "op": "gt", "match": "1" }
```
