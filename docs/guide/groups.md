# Groups & Access Control

Routes belong to groups. Groups scope admin access and can restrict which events flow into them. They are stored in D1 (`d1_groups`, seeded from the legacy KV `config:groups` key on first load), managed via the [Web UI](./configuration#web-ui) or the [Admin API](../api/admin). The bulk groups write accepts at most **100 groups** per save.

## Group Schema

```json
{
  "id": "backend-team",
  "name": "Backend Team",
  "members": [
    { "login": "rhencloud", "role": "owner" },
    { "login": "octobot", "role": "admin" },
    { "login": "reader", "role": "viewer" }
  ],
  "owners": ["myorg"],
  "providers": ["github", "gitea"],
  "installationId": 12345678,
  "logTarget": { "platform": "discord", "channelId": "123456789", "threadId": "987654321" }
}
```

| Field            | Type     | Required | Description                                                                                                                                                                                                                                                         |
| ---------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | string   | Yes      | Lowercase id (`a-z0-9`, `-`); referenced by each route's `groupId`. Editable: renaming re-points its routes, fragments, history, webhook secret and pending invites; a deleted or renamed id stays retired for a few days                                           |
| `name`           | string   | Yes      | Human-readable group name                                                                                                                                                                                                                                           |
| `members`        | object[] | Yes¹     | `{ login, role }` entries; role is `owner`, `admin`, or `viewer`. Each entry is bound to a GitHub user id by the server (resolved when the member is added, or at their first sign-in); a bound entry matches only that account, even after the login changes hands |
| `adminIds`       | string[] | No       | Deprecated legacy field; treated as `members` with role `owner` when present                                                                                                                                                                                        |
| `owners`         | string[] | No       | Org/user logins whose events are accepted into this group; empty = all                                                                                                                                                                                              |
| `providers`      | string[] | No       | Source platforms allowed into this group (`github`, `gitea`, `custom`); empty = all                                                                                                                                                                                 |
| `installationId` | number   | No       | GitHub App installation id bound to this group; only that installation's events are accepted (empty = all). Super-admin only (set by the verified install flow)                                                                                                     |
| `isolated`       | boolean  | No       | Isolated groups (self sign-up personal groups) only receive events from their own `/webhook/{groupId}` ingress until a super admin binds a source (`installationId` or `owners`). Super-admin only                                                                  |
| `emoji`          | boolean  | No       | Whether to include emoji in this group's messages (default `true`)                                                                                                                                                                                                  |
| `forgeSources`   | object[] | No       | Forge hosts: `{ host, type, name? }` entries (`type` is `github` or `gitea`, `name` is an optional display label) that label this group's message footers; empty = no label                                                                                         |
| `lang`           | string   | No       | Message language for every route in this group (e.g. `en`, `zh`; custom via KV `i18n:<lang>`) — see [Message Language](./i18n) — defaults to `en`                                                                                                                   |
| `logTarget`      | object   | No       | Webhook log channel: a Discord `{ platform, channelId, threadId? }`, Telegram `{ platform, chatId, topicId? }` or Feishu `{ platform, chatId }` target that receives a summary of every webhook the group's routes dispatch                                         |

¹ `members` or the legacy `adminIds` must be present. A non-empty `members` list needs at least one `owner`; an empty list is allowed (only super admins manage such a group). `forgeSources` takes at most 20 entries, each `name` at most 50 characters, and no two entries with the same type and host.

## Roles

Every group member has one of three roles. Super admins (`ADMIN_USER_IDS`) always bypass them.

| Role     | View routes/logs | Edit routes | Manage members & invites | Edit group settings |
| -------- | ---------------- | ----------- | ------------------------ | ------------------- |
| `owner`  | ✓                | ✓           | ✓                        | ✓ (except `owners`) |
| `admin`  | ✓                | ✓           | ✗                        | ✗                   |
| `viewer` | ✓ (read-only)    | ✗           | ✗                        | ✗                   |

## Access Model

- **Super admins** (`ADMIN_USER_IDS`) see and edit every group and all routes; only they can edit a group's source-isolation fields (`owners`, `installationId`, `isolated`) — an owner's save keeps the stored values.
- **Owners** manage their group's routes, members, invites, name, id, `emoji`, and `providers`. They cannot remove the last owner or demote themselves when no other owner remains.
- **Admins** edit routes inside their groups and view logs; **viewers** get a read-only console.
- Group admin endpoints operate on a single group at a time via `/admin/api/groups/:id/routes`; `groupId` is forced from the path parameter.
- The `owners` list restricts the group's routes to events of repositories owned by these users or organizations (`repository.owner.login` / `organization.login`); to filter by who triggered an event, use an `actor` filter.
- A route whose group no longer exists never fires.
- Every group write is a single-row, compare-and-swap update: two people editing different groups never overwrite each other, and an edit made from a stale copy of the same group is refused (`409`, the console reloads) instead of reverting the newer change. Route and fragment lists work the same way per group.
- Roles are checked again inside the write itself: a request authorized before the writer lost their role (or was removed) is refused when it commits.
- Deleting a group requires the confirmation snapshot the console shows (`revision`, `routesRevision` and the group `version`): anything added or changed after the confirmation — a route, a fragment, a setting — makes the delete fail with `409` instead of being deleted unseen. A group with routes that cannot be read is not deleted.
- Delivery targets are owned: a non-super admin cannot point routes or the log channel at a channel/chat another group already delivers to, unless they may edit that group's routes too (`403`). A channel that two groups already shared before keeps working only where it is already used.
- The `providers` list restricts which forge's events (`github`, `gitea`) the group's routes will dispatch. This lets you keep GitHub and Gitea groups separate even when org/user names collide.

## Webhook Log Channel

A group may set `logTarget` to a Discord channel/thread, Telegram chat/topic or Feishu chat. Whenever the group's routes dispatch a webhook, a single summary message is sent there: the event type/action, the repo, the delivery id, and one line per route×target with an ✅/❌ outcome (including the error for failed sends; targets finished by an earlier attempt are listed as such; at most the first 10 lines are listed, the rest is summarized as `+N`). The message is green when every dispatch succeeded, red when any failed, and gray when earlier attempts' outcomes are not known. A retried delivery with the same outcome does not send the summary again. The summary uses the group's message language. Log messages are sent best-effort and are not themselves recorded in the D1 send log.

## Forge Source Label

A group defines the forges it receives events from via `forgeSources`, a list of `{ host, type, name? }` entries (`type` is `github` or `gitea`). Every message this group's routes send carries the footer label of the **first entry whose type matches the event's provider and whose host matches the repository URL's hostname** (GitHub events match `github.com`). The label is the entry's optional `name` — falling back to the host — so two self-hosted Gitea instances can be shown as "内网 Gitea" / "Git2 仓库" while matched by their distinct hosts:

```json
{
  "forgeSources": [
    { "host": "github.com", "type": "github", "name": "GitHub 主站" },
    { "host": "git1.example.com", "type": "gitea", "name": "内网 Gitea" },
    { "host": "git2.example.com", "type": "gitea" }
  ]
}
```

- **Discord** — the embed footer shows the label next to the repo (`内网 Gitea · acme/widget`) with a site icon as the footer icon: GitHub's `fluidicon.png` or the Gitea instance's `/assets/img/favicon.png` (both raster PNGs — Discord silently ignores `.ico` favicons).
- **Telegram** — the footer line starts with the hyperlinked label (`[内网 Gitea](https://git1.example.com)`).
- Events whose repository host has no matching entry (e.g. custom webhooks, or a repo hosted elsewhere) get no label.

The label is independent of `Group.emoji` and follows every message that group dispatches (including in-place edits of workflow/check messages).

## Invites

Owners (and super admins) can create single-use invite links valid for 7 days from the group's _Members_ panel. Accepting an invite adds the user with the invited role (`admin` or `viewer` — never `owner`); an existing `viewer` is upgraded to `admin`. Invites are stored in KV as `invite:{token}` for their whole lifetime; the "used" record commits in the same D1 transaction as the membership change, so a link can be used only once even when two people open it at the same time.

- An invite belongs to the group instance that issued it: a group later created under the same id never accepts it.
- Revoking an invite is recorded in D1 and takes effect at once, even where KV still has the invite.
- An invite stops working when its issuer is no longer an owner of the group.
- If the login is still on a member entry bound to another GitHub account (the former holder of that login), accepting fails with a conflict and the invite stays usable; an owner first removes the stale entry.

## Self Sign-up

With `ALLOW_SELF_SIGNUP=1`, a GitHub user who has no group access gets a personal group (`u-{userId}`, owned by them) on first login instead of a `403`. This is the entry point for a fully self-service SaaS install; disable it to keep the console invite-only.

Personal groups are **isolated** (groups named `u-<digits>` created before the flag existed count as isolated too, unless a super admin sets `isolated: false`): the operator's global `POST /webhook` endpoint never dispatches to them, so a self-service user cannot receive other tenants' events by adding a catch-all route. They receive events through their own [per-group webhook](./ingress) — or from a GitHub App installation they prove they administer (the install flow checks it with the user's own GitHub token).
