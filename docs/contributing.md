# Contributing

## Development Setup

```bash
git clone https://github.com/Elysola/WebHooker.git
cd WebHooker
bun install
cp .env.example .dev.vars   # Fill in secrets
bun run dev                  # Start local dev server
```

## Project Structure

```text
app/                     # Vue 3 UI (Nuxt app dir)
├── app.vue              # Root component (NuxtPage)
├── assets/css/main.css  # Tailwind CSS v4 entry: Elysola UI-compatible RGB aliases + bespoke layout classes
├── pages/               # index (landing), terms, privacy, admin/[...slug] (console SPA)
├── components/          # ConsolePage, RouteCard/Editor, GroupEditor, MembersPanel, WebhookPanel,
│                        # SendLogs, AuditLog, AppToasts, LegalLayout
├── composables/         # useI18n, useToasts, useGroups, useGroupRoutes, useLogs, useAudit, useInvites, useWebhook
├── types.ts             # Shared client types (Route, Group, Filter, ...)
└── utils/legal.ts       # Terms/privacy HTML bodies (zh/en)
server/                  # Nitro server (H3 handlers in server/routes/)
├── routes/              # /health, /webhook[/:groupId], /discord/interactions, /telegram/webhook,
│                        # /auth/github*, /admin/{login,logout,invite,api/**}, /api/{comment,merge,close,react,richheader}
├── tasks/               # Scheduled (cron */5): discord-sync, telegram-sync, audit-prune
├── error-handler.ts     # JSON error handler
└── lib/
    ├── types.ts         # Env, Config, Route, Filter, Group, WebhookEvent, NeutralMessage
    ├── config.ts        # Loads routes from KV (returns [] if unset), builds Config from env
    ├── core/
    │   └── dispatch.ts  # Platform-neutral dispatch: match routes → formatEvent → getDriver().send/edit
    ├── events/          # Provider-agnostic route matching
    │   └── match.ts     # matchRoute, eventOwners, extractBranch, keyword filtering
    ├── providers/       # Forge webhook providers (verify + parse/normalize)
    │   ├── types.ts     # Provider interface (matches/verify/parse)
    │   ├── index.ts     # detectProvider() registry (github, gitea, custom)
    │   ├── github/      # X-GitHub-Event + X-Hub-Signature-256
    │   └── gitea/       # X-Gitea-Event + X-Gitea-Signature (normalized payloads)
    ├── formatters/      # Platform-neutral formatters (produce NeutralMessage)
    │   ├── index.ts     # formatEvent: 28-event switch + custom → NeutralMessage + re-exports
    │   ├── colors.ts    # GITHUB_COLORS + WORKFLOW_CONCLUSION_EMOJI
    │   ├── helpers.ts   # emojiPrefix, T, buildMessage, commitLink/branchLink/tagLink
    │   └── *.ts         # push, pull-request, issues, comments, workflow, release, create, repo,
    │                    # check, review, commit-comment, deployment, member, label, milestone,
    │                    # discussion, repository, security, generic, ping, custom
    ├── drivers/         # Platform drivers (pluggable push targets)
    │   ├── types.ts     # PlatformDriver interface + SendResult (send + edit)
    │   ├── index.ts     # getDriver() registry (discord + telegram + feishu)
    │   ├── discord/     # index.ts (driver), render.ts (NeutralMessage → embed),
    │   │                # rest.ts, interactions.ts, commands.ts
    │   └── telegram/    # index.ts (driver), render.ts (NeutralMessage → Telegram HTML),
    │                    # rest.ts (chat_id + message_thread_id), updates.ts (webhook verify),
    │                    # commands.ts (/gh login|logout|comment|merge|close + reply parsing)
    ├── github/          # GitHub OAuth + as-user actions
    │   ├── oauth.ts     # OAuth URL, callback token exchange, getUserOctokit, comment/merge/close actions
    │   └── store.ts     # KV token CRUD + D1 discord-link/telegram-link mapping
    ├── web/             # HTTP UI/API logic (called from server/routes)
    │   ├── oauth.ts     # GET /auth/github, callback (admin session / discord-link / telegram-link / install bind)
    │   ├── actions.ts   # POST /api/comment|merge|close|react (Bearer token auth via KV lookup)
    │   ├── admin.ts     # /admin API: routes, groups, me, logs, invites, audit (session + scope auth)
    │   ├── auth.ts      # Shared auth middleware + guards
    │   ├── invites.ts   # Invite CRUD + acceptInvite
    │   ├── session.ts   # Admin session CRUD (KV session:{id}), cookie helpers
    │   ├── groups.ts    # Group loading, group-admin access scoping
    │   ├── tenants.ts   # Per-group webhook secret CRUD
    │   └── richheader.ts # GET /api/richheader (Telegram avatar card)
    └── lib/             # Shared infrastructure
        ├── i18n.ts      # Message language overrides (en/zh)
        ├── send-log.ts  # Send logging (D1 send_logs)
        ├── audit.ts     # Audit logging (D1 audit_logs)
        ├── log.ts       # JSON console logger (info/warn/error/fatal)
        └── locales/     # en.ts, zh.ts translation dictionaries

tests/                   # Unit tests (bun test)
tests/fixtures/          # Provider payload fixtures (github/gitea/custom)
tests/__snapshots__/     # Formatter snapshot golden files
```

Continuous integration (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile`,
`bun test`, and `bun run lint`. CodeQL (`codeql.yml`) and Dependabot (`dependabot.yml`) are
configured under `.github/`.

## Scripts

| Command                | Description                     |
| ---------------------- | ------------------------------- |
| `bun run dev`          | Start Nuxt dev server (HMR)     |
| `bun run typecheck`    | TypeScript type checking        |
| `bun run lint`         | ESLint (TypeScript)             |
| `bun run lint:md`      | Markdownlint (Markdown)         |
| `bun test`             | Run unit tests (bun test)       |
| `bun run format`       | Format all files with Prettier  |
| `bun run format:check` | Check Prettier formatting       |
| `bun run docs:dev`     | Start VitePress docs dev server |
| `bun run docs:build`   | Build docs site                 |

## Code Style

- **TypeScript** with strict mode
- **Double quotes** for strings
- **Semicolons** required
- **Trailing commas** in all positions
- **100 char** print width
- **ESLint** with `@typescript-eslint` recommended rules
- **Prettier** for formatting
- **Markdownlint** for markdown files

## Testing

```bash
# Run the unit test suite (bun test)
bun test

# Or manually check the health endpoint
curl http://localhost:8787/health
```

Beyond the per-module unit tests, the suite includes provider fixtures
(`tests/fixtures/` + `tests/provider-fixtures.test.ts`), formatter snapshots
(`tests/formatter-snapshot.test.ts`), and platform contract tests
(`tests/platform-contract.test.ts`) that assert the Discord/Telegram renderers clamp to their
platform limits.

## Adding a New Event Formatter

1. Add the event type to `GITHUB_COLORS` in `server/lib/formatters/colors.ts` (if new color needed)
2. Add action labels to the locale dictionaries in `server/lib/lib/locales/en.ts` and `server/lib/lib/locales/zh.ts` (if new actions)
3. Create a `formatEventType` function in `server/lib/formatters/`
4. Add the case to the `formatEvent` switch statement in `server/lib/formatters/index.ts`
5. Update `extractBranch` in `server/lib/events/match.ts` if the event has branch info
6. Add the event to the documentation in `docs/events/supported.md` and `docs/zh/events/supported.md`
7. Add the event to the README (`README.md` and `README.zh.md`) event tables and the GitHub App event subscription list
8. Subscribe to the event in your GitHub App settings

## Pull Request Guidelines

- Keep changes focused and atomic
- Include type annotations for all function returns
- Run `bun run typecheck && bun run lint && bun run format:check` before submitting
- Update documentation if adding features (see the checklist in `AGENTS.md` → Documentation): README (`README.md` / `README.zh.md`), VitePress docs (`docs/` and `docs/zh/`), and example config files
