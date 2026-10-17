# Admin API

Admin endpoints manage routes, groups, members, invites, webhook secrets, send logs, and the audit log. They require an admin session cookie obtained via `GET /admin/login` (GitHub OAuth); the signed-in user must be listed in `ADMIN_USER_IDS` or manage a group. For local development only, exact `DEBUG_MODE=true` bypasses authentication and grants full access; never deploy with it enabled. See [Configuration → Web UI](../guide/configuration.md#web-ui) for setup.

The console itself is served at `/admin`; its tabs are deep-linkable via the URL path (`/admin/groups`, `/admin/logs`, `/admin/audit`).

## Endpoints

| Endpoint                                        | Description                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /admin`                                    | Config console UI                                                                                                                                                        |
| `GET /admin/login`                              | Start admin sign-in (GitHub OAuth)                                                                                                                                       |
| `GET /admin/logout`                             | Sign out and destroy the session                                                                                                                                         |
| `GET /admin/invite?token=…`                     | Accept a group invite (browser page)                                                                                                                                     |
| `GET /admin/api/me`                             | Current session, scope, groups, and roles                                                                                                                                |
| `GET /admin/api/routes`                         | List routes (scoped to access)                                                                                                                                           |
| `PUT /admin/api/routes`                         | Replace routes (owner/admin per group)                                                                                                                                   |
| `GET /admin/api/groups`                         | List groups + the signed-in user's role in each                                                                                                                          |
| `PUT /admin/api/groups`                         | Replace groups (super: all; owner: own only)                                                                                                                             |
| `GET /admin/api/groups/:id/routes`              | List a group's routes                                                                                                                                                    |
| `PUT /admin/api/groups/:id/routes`              | Replace a group's routes (owner/admin)                                                                                                                                   |
| `GET /admin/api/groups/:id/fragments`           | List a group's named filter fragments                                                                                                                                    |
| `PUT /admin/api/groups/:id/fragments`           | Replace a group's named filter fragments (owner/admin)                                                                                                                   |
| `PUT /admin/api/groups/:id/rename`              | Rename a group (owner); routes, webhook secret and invites follow (routes are moved before the group record is updated)                                                  |
| `GET /admin/api/groups/:id/invites`             | List pending invites (owner)                                                                                                                                             |
| `POST /admin/api/groups/:id/invites`            | Create an invite link (owner)                                                                                                                                            |
| `DELETE /admin/api/invites/:token`              | Revoke an invite (owner)                                                                                                                                                 |
| `GET /admin/api/groups/:id/webhook`             | Group webhook endpoint info (owner)                                                                                                                                      |
| `POST /admin/api/groups/:id/webhook/regenerate` | Generate/regenerate the group webhook secret (owner)                                                                                                                     |
| `DELETE /admin/api/groups/:id/webhook`          | Disable the group webhook ingress (owner)                                                                                                                                |
| `GET /admin/api/logs`                           | Send logs (scoped to accessible routes)                                                                                                                                  |
| `GET /admin/api/logs/:id`                       | Single send-log entry (scoped)                                                                                                                                           |
| `GET /admin/api/audit`                          | Audit log (scoped to accessible groups)                                                                                                                                  |
| `GET /admin/api/metrics`                        | Delivery stats (totals, failure rate, per platform/event/status, recent failures); optional `?groupId=` scope; recent failures scoped to accessible groups for non-super |
| `GET /admin/api/delivery/:deliveryId`           | All send-log attempts for one delivery (group-scoped)                                                                                                                    |
| `POST /admin/api/test-match`                    | Stateless filter dry-run — evaluate a filter node against a pasted JSON payload (no event is stored)                                                                     |

## Validation

- `PUT /admin/api/routes` — Body `{ "routes": Route[] }`; validates each route (id pattern, unique id within its group, name, enabled, `groupId`, filters — empty only allowed for `fallback` routes — optional `discordRoleIds` (list of role id strings), and platform-aware targets: `target.channelId` for Discord, `target.chatId` for Telegram) and persists to D1 `d1_routes`. Returns `200 { ok, count }` or `400 { error }` / `401 { error }` / `403 { error }`. Unchanged routes skip the full validation. Route filters support the `field` type (a JSONPath `path` into `payload`, arrays expand so any element matches) and 12 `op` operators (`eq` default / `ne` / `contains` / `startsWith` / `endsWith` / `regex` / `gt` / `gte` / `lt` / `lte` / `in` / `exists`); a nested `ast` (`all` / `any` / `not`) takes precedence over `filters` when present.
- `PUT /admin/api/groups` — Validates group ids, member roles (at least one `owner`), `providers` (`github` / `gitea`), and `installationId`.
- `POST /admin/api/test-match` — Body `{ "node": FilterNode | "filters": Filter[], "event"?: string, "payload": object }`; evaluates in memory and returns `{ matched, explanation }`. Nothing is persisted.
- `GET/PUT /admin/api/groups/:id/fragments` — Named filter fragments (`{ id, groupId, name, node }`) stored in D1 `d1_fragments`; the editor inlines a fragment's `node` into a route's `ast` on insert (the matcher never resolves fragment references). `PUT` replaces the group's fragments and returns `200 { ok, count }`.
- Limits: at most 200 routes and 100 groups per instance.

Schemas: [Routes & Targets](../guide/routes), [Groups & Access Control](../guide/groups).
