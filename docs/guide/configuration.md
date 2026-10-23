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

> [!IMPORTANT]
> Inbound Feishu commands and card buttons (`POST /feishu/webhook`) require
> `FEISHU_ENCRYPT_KEY` and/or `FEISHU_VERIFICATION_TOKEN` (the app's **Events &
> Callbacks → Encryption Strategy** values). Without either, the endpoint refuses
> every callback, since an unauthenticated request could act as any linked user.

<!-- separate the two alerts (MD028) -->

> [!NOTE]
> `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY` (PKCS#8 PEM) are used by the GitHub App
> **install flow** (`/auth/github/install`) to resolve the installation's account via
> an App JWT — which is also how the flow verifies that the signed-in user may manage
> the installation. Without them only super admins can bind installations. The OAuth
> flow itself only needs `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`; it requests the
> `repo` and `read:org` scopes (the latter to check organization admin rights).

### Optional Secrets

| Variable                    | Description                                                                                                                                                | Default                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `DISCORD_PUBLIC_KEY`        | Discord application public key (Developer Portal) — required for interactions                                                                              | Unset → interactions return `401` |
| `DISCORD_APPLICATION_ID`    | Discord application id; auto-resolved when omitted                                                                                                         | Auto-resolved                     |
| `TELEGRAM_WEBHOOK_SECRET`   | Secret token for `POST /telegram/webhook` verification (X-Telegram-Bot-Api-Secret-Token)                                                                   | Derived from `TELEGRAM_TOKEN`     |
| `FEISHU_ENCRYPT_KEY`        | Feishu event Encrypt Key: verifies `X-Lark-Signature` and decrypts encrypted callbacks                                                                     | Unset                             |
| `FEISHU_VERIFICATION_TOKEN` | Feishu event Verification Token, compared with the token in every callback                                                                                 | Unset                             |
| `TELEGRAM_RICH_HEADER_HOST` | Base URL of an external rich-header service; when unset, the built-in `GET /api/richheader` serves the Telegram avatar card                                | Built-in `/api/richheader`        |
| `BASE_URL`                  | Public URL of the worker, for OAuth callbacks and the Telegram webhook sync                                                                                | Unset — required in production    |
| `ADMIN_USER_IDS`            | Comma-separated GitHub user IDs (or logins) allowed to access the Web UI; prefer numeric ids — a login is bound to the first account that signs in with it | Disabled                          |
| `DEBUG_MODE`                | Local development only: exact `true` bypasses all `/admin` authentication and grants full access                                                           | Disabled                          |
| `ALLOW_SELF_SIGNUP`         | When enabled (`1`/`true`), GitHub users without any group access get an isolated personal group on first login instead of `403`                            | Disabled                          |
| `AUDIT_RETENTION_DAYS`      | Audit-log retention in days for the scheduled cleanup                                                                                                      | `90`                              |
| `NUXT_PUBLIC_DOCS_URL`      | Docs site URL used by the landing page (client-side runtime config)                                                                                        | Landing page defaults             |
| `NUXT_PUBLIC_REPO_URL`      | GitHub repo URL used by the landing page                                                                                                                   | Landing page defaults             |
| `NUXT_PUBLIC_LEGAL_CONTACT` | Contact shown on `/terms` and `/privacy`                                                                                                                   | Unset → placeholder text          |

## Web UI

WebHooker ships with a built-in config console at `/admin` for managing routes, groups, members, invites, send logs, and the audit log in the browser. It is protected by GitHub OAuth plus an admin whitelist.

### Setup

1. Configure `ADMIN_USER_IDS` with the GitHub user IDs allowed to manage everything. Logins are also accepted, e.g. `ADMIN_USER_IDS=12345,RhenCloud`, but numeric ids are safer: GitHub logins can be renamed and re-registered, so a login is bound to the first account that signs in with it. If unset, there are no super admins: members of a group still reach the console for their groups, and `ALLOW_SELF_SIGNUP` gives other users a personal group.
2. Open `/admin` and sign in with GitHub.
3. Users without any access get `403`, except when `ALLOW_SELF_SIGNUP=1` (they receive a personal group) or when they follow a group [invite link](./groups#invites).

For local debugging only, set `DEBUG_MODE=true` to bypass GitHub OAuth and grant complete console access. Do not set this variable in a deployed environment.

The console is served as an SPA at `/admin`; its tabs are deep-linkable via the URL path (`/admin/groups`, `/admin/logs`, `/admin/audit`), and each group's routes page has its own URL (`/admin/groups/{groupId}`). Pages are browser history entries: use the browser's (or device's) back button to return from a group to the group list; leaving a page with an open editor or an unsaved route order asks for confirmation first. Unknown console paths return the console's 404 page. URLs outside `/admin` that do not match an endpoint return a plain `404` instead of the console.

Destructive actions — deleting routes, groups, filter conditions, fragments, targets or forge hosts, removing members, revoking invites, disabling a group's webhook — ask for confirmation in an in-app dialog (empty, never-filled rows are removed directly). The route and group editors ignore clicks on the backdrop so unsaved input is never lost; close them with Cancel, ✕ or <kbd>Esc</kbd>.

All management endpoints (`/admin/api/*`) are documented in the [Admin API](../api/admin). Saved routes and groups are persisted to D1 (`d1_routes` / `d1_groups`) immediately; webhook ingress and the queue consumer read the configuration fresh, so the next event already uses them.

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
- Every filter except `keyword` (which only supports the default `eq`) accepts an `op` operator — `eq` (default, classic behaviour), `ne`, `contains`, `startsWith`, `endsWith`, `regex`, `gt`, `gte`, `lt`, `lte`, `in`, `exists` — see the [Filter Tutorial](./filters#operators)
- `field` filters use a dot-separated JSONPath `path` into the payload; arrays are expanded so any matching element satisfies the filter
- Routes may nest filters in an `ast` node (`all` / `any` / `not`) instead of a flat `filters` list; `ast` takes precedence when present
- Globs and regexes run on the RE2 engine (linear time). A pattern the matcher cannot compile — longer than 200 characters, or using syntax RE2 lacks such as backreferences or lookaround — is rejected when saved; one stored before makes its route [unreadable](./routes#unreadable-routes) instead of silently never matching
- `branch` filter works for push, pull_request, pull_request_review, pull_request_review_comment, create/delete, workflow_run, workflow_job, check_run, check_suite, deployment, deployment_status, and code_scanning_alert events

### Match Values

Filters accept either a single string or an array of strings:

```json
{ "type": "event", "match": "push" }
{ "type": "event", "match": ["push", "pull_request"] }
{ "type": "field", "path": "pull_request.commits", "op": "gt", "match": "1" }
```
