# Message Format

Every event formatter produces a platform-neutral message (`NeutralMessage`), rendered by the platform drivers into a Discord embed or Telegram HTML message.

## Title

Every title must start with the repo, then an optional `#number`, then `: subject`:

```
{repo}{#number}: {subject}      e.g. acme/widget#7: Add feature
```

The repo comes from `payload.repository.full_name` (falling back to a generic "repository" label when missing). Comments, reviews, and inline comments use the same `{repo}{#number}: {title}` title as their parent object — never `"Comment on org/repo"` prefixes.

## Links

Only the repo head is hyperlinked — never the whole title:

- **Discord** (embed titles cannot contain partial links): the title is the repo head `{repo}{#number}`, linked to the event's object (the issue, PR, comment or run page); the `: {subject}` text is rendered as the first line of the description, unlinked.
- **Telegram** (HTML supports inline links): the one-line title keeps the subject, with only the repo head wrapped in a link.

Messages whose title has no colon separator (a `:` followed by a space) keep the legacy whole-title link behavior.

Commit hashes, branches, and tags render as inline code wrapped in a hyperlink (e.g. ``[`abc123d`](https://…/commit/abc123def456)``), falling back to plain inline code when the repo base URL is unavailable.

Branch and tag creation or deletion messages link their repository title to the corresponding branch or tag page.

For push events, when a commit author's GitHub username differs from the pusher, the commit line ends with a link to that author (e.g. `- [octocat](https://github.com/octocat)`). When GitHub cannot resolve a bot account and returns `invalid-email-address`, the commit's author name is shown without a link.

## Emoji

Event-specific emoji are added by the formatters; per-group `Group.emoji` (default true) strips them all when disabled. Milestone progress bars are exempt. See [Message Language](./i18n).

## Forge Source Label

With `Group.forgeSources` (a list of `{ host, type, name? }` entries) the message footer names the matching source — the first entry whose type (`github` / `gitea`) matches the event's provider and whose host matches the repository URL's hostname, labeled with its optional `name` (falling back to the host) — so events from different forges can be told apart. See [Groups → Forge Source Label](./groups#forge-source-label).

## In-Place Updates

Messages about an object that changes over time are sent once and edited in place as it changes — `workflow_run` and `check_run` / `check_suite` as the run progresses (queued → running → success/failure), deployments and their statuses, issue comments, pull request reviews and review comments as they are edited or deleted — instead of posting a new message. Each edit re-renders the whole message from the newest event. Tracking uses D1 `message_tracking` (KV `msg:*` as fallback) with a stable `updateKey` per object: `workflow_run` keys on the run id, `check_suite` on the suite id, while `check_run` keys on the check suite (or app) + check name + commit SHA (falling back to the run id) so deployments that emit a fresh run id per phase — e.g. Cloudflare Pages — still edit the same message. The chain is also keyed by the forge (provider + repository host) and the target platform, so two Gitea instances with the same `owner/repo` never edit each other's messages. An event older than the state a message already shows (delivered late) does not overwrite it; a failed edit is reported as a failure rather than posting a second message — a new message is sent only when the old one no longer exists.

## Workflow Jobs

`workflow_run` messages include a **Jobs** field listing every job in the run as a colored diff code block (Discord):

```
+ build ✅ success · 1m 23s
  deploy 🔄 running
  lint ⏳ queued
- test ❌ failure · 0m 45s
```

Each line is `{name} {emoji}{status}` plus the job duration when it has completed. Successful jobs are prefixed with `+` (green), failed/other finished jobs with `-` (red), and running/queued/pending jobs use a plain space (no color). The job name is clamped to 200 chars and the whole field to the platform field limit. Drivers without diff support (Telegram, Feishu) render the block as a single inline code span.

The `workflow_run` webhook payload itself carries no job list — only a `jobs_url`. The worker fetches the jobs from that URL (one GitHub API call per delivery, skipped when no route matches): authenticated with a GitHub App installation token when `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` are configured, otherwise unauthenticated (public repositories only). The App therefore needs the **Actions: read** repository permission. If the fetch fails (missing permission, private repo without App creds, rate limit) the message simply omits the Jobs field.
