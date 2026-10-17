# AGENTS.md — WebHooker

## Project Purpose

Nuxt 4 (Nitro) app deployed as a Cloudflare Worker that receives GitHub webhooks and dispatches processed events to Discord channels/threads, Telegram chats/topics and Feishu group chats, and receives Discord interactions (slash commands, buttons, modals) via the Interactions Endpoint plus Telegram bot `/gh` commands and Feishu bot `/gh` commands + card buttons via their respective webhooks.

Core pipeline: GitHub Webhook → Worker (verify + filter + format) → Discord (REST) / Telegram (Bot API)

## Key Decisions

- Runtime: Cloudflare Workers via the Nitro `cloudflare_module` preset (`_worker.js`), H3 event handlers in `server/routes/`
- UI: Vue 3 + Tailwind CSS v4 (`@tailwindcss/vite`) + `@elysola/ui` (Nuxt module, `Rc` prefix); admin console is a client-side SPA (`routeRules: "/admin/**": { ssr: false }`), home/legal pages render server-side
- Styling: Elysola UI supplies semantic components and blue theme tokens; `app/assets/css/main.css` retains `--wh-*` RGB-triplet aliases for app-specific Tailwind utilities and bespoke layouts (avoiding collision with Elysola's `--surface`/`--text`/`--border` hex tokens); theme switching supports auto/light/dark via `useTheme` / `ThemeToggle`, toggling `<html>.dark` with inline anti-flash head script
- Discord interactions: HTTPS Interactions Endpoint (`POST /discord/interactions`, Ed25519-signed) — no Discord Gateway / Durable Object; bot stays offline, messages always sent via REST
- Storage: D1 is the source of truth for config (routes/groups via `d1_routes`/`d1_groups`, see `server/lib/storage/config-store.ts`), send/audit logs, dedup (`dedup_keys`), delivery state (`delivery_state`) and message tracking (`message_tracking` via `server/lib/storage/d1.ts` `canUseD1` gate). KV keeps only cache + short-lived/ephemeral state (tokens, OAuth state, admin sessions, `msg:*`-adjacent locks, per-group secrets `tenant:*`, invites, i18n overrides) with explicit TTLs. R2 parks oversized queue payloads (`webhooks/YYYY/MM/DD/*.json`, `server/lib/storage/payload.ts`) instead of KV. A `storage-prune` scheduled task cleans up expired dedup/delivery/message-tracking rows
- Signature verification: Web Crypto API (HMAC-SHA256 for GitHub/Gitea, Ed25519 for Discord, timing-safe secret-token compare for Telegram)
- Webhook providers: pluggable forge adapters under `server/lib/providers/` (github, gitea) — each verifies its own signature format and normalizes its payload to a GitHub-shaped `WebhookEvent`; a `custom` provider accepts arbitrary signed JSON posts (`X-WebHooker-Signature`) as `custom` events; GitLab etc. can be added later
- Per-group webhook ingress: optional `POST /webhook/{groupId}` with a per-group secret in KV (`tenant:{groupId}`) — Gitea/classic-GitHub/custom webhooks are verified against the group's secret instead of the operator's global ones; only that group's routes fire. The legacy `POST /webhook` (global secrets, all routes) stays untouched
- GitHub App tenant isolation: `Group.installationId` binds a group to one GitHub App installation; events whose `payload.installation.id` differs are rejected at dispatch (hard isolation on top of the optional `owners` list). The App's Setup URL points at `GET /auth/github/install`, which renders a choice page (create `inst-{installationId}` or bind to a group the signed-in user owns, verified by role); `POST /auth/github/install/bind` performs the provisioning. `installation.created` webhook events auto-provision as a fallback (create `inst-{installationId}` or bind existing groups whose `owners` match the installing account)
- GitHub OAuth: octokit (token is stored hashed for reverse lookup)
- Admin WebUI: `/admin` config console, OAuth-session protected via `ADMIN_USER_IDS` whitelist (local-only `DEBUG_MODE=true` bypasses authentication); left sidebar navigation (Overview / Groups / Send Logs / Audit / Stats) + topbar, deep-linkable routes (`/admin` overview · `/admin/groups` · `/admin/logs` · `/admin/audit` · `/admin/metrics`); the overview dashboard (`AdminHome.vue`) aggregates delivery KPIs, a routes table and recent send logs; the stats page (`MetricsPanel.vue`) renders KPI cards plus per-platform/per-event ok/failed bar legends and a per-status breakdown, and filters by group (`?groupId=`); the route/group editors (`RouteEditor.vue` / `GroupEditor.vue`) are centered, scrollable `RcDialog` forms with an eyebrow header and sectioned bodies
- Access control: every group has role-based members (`owner` / `admin` / `viewer`); super admins bypass; legacy `adminIds` are read as owners (backward compatible); owners manage members + invites; `owners` field stays super-only
- Invites: single-use 7-day links (`invite:{token}`) for joining a group as admin/viewer; `ALLOW_SELF_SIGNUP=1` gives access-less users a personal group on first login (self-service SaaS entry)
- Audit log: every admin operation (logins, group/route/member/invite changes) recorded in D1 `audit_logs`; pruned by the scheduled trigger after `AUDIT_RETENTION_DAYS` (default 90)
- Group webhook log channel: optional `Group.logTarget` (Discord channel/thread or Telegram chat/topic) receives one summary message per webhook the group's routes dispatched (event, repo, delivery id, per route×target ✅/❌ outcome, green/red color); best-effort, not recorded in `send_logs`
- Per-group forge branding: optional `Group.forgeSources` (a list of `{ host, type: "github" | "gitea", name? }` the group defines itself) labels each message's footer with the first entry whose type matches the event's provider and whose host matches the repository URL's hostname (GitHub matches `github.com`, so two Gitea instances can be `git1.example.com`/`git2.example.com`); the label is the entry's optional `name` (fallback: host); links are derived from the repo URL and footer icons use raster PNGs Discord renders (GitHub's `fluidicon.png`, Gitea's `/assets/img/favicon.png` — `.ico` favicons are silently ignored); Discord shows the footer icon + name, Telegram a linked name
- Delivery queue: when the `QUEUE` binding is present, webhook ingress enqueues one message per event (not per target) to a Cloudflare Queue (`webhooker-delivery`); a Nitro `cloudflare:queue` plugin consumes batches, dispatches, and retries retryable failures (5xx/network/429-exhaustion) with exponential backoff (5s/30s/2m/10m) up to the queue `max_retries`, after which the DLQ (`webhooker-delivery-dlq`) marks the delivery dead. Oversized payloads (>~100 KB) are parked in R2 (`webhooks/YYYY/MM/DD/*.json`, falling back to KV `queue:payload:*` without the R2 binding) and resolved by the consumer; delivery state is tracked as the D1 `delivery_state` table (KV `delivery-state:*` fallback). Without the `QUEUE` binding, dispatch stays inline (existing behavior)
- Storage quotas: the design avoids KV write pressure (Workers Free KV allows ~1,000 writes/day) by keeping high-frequency ephemeral writes in D1 instead — webhook dedup (`dedup_keys`, atomic `ON CONFLICT` UPSERT), delivery state and message tracking all use D1 rows via `canUseD1` (prepare+batch probe) with automatic KV fallback when D1 is unavailable or unmigrated. D1 Free allows 100,000 rows written/day, so the per-event KV write cost drops to ~0; config stays cached in memory + KV with D1 authoritative
- Filter DSL: a route's flat `filters` can be replaced by a nested `ast` (`all`/`any`/`not` nodes, `server/lib/events/filter-ast.ts`) that takes precedence when present; the `field` filter type reads any payload value by JSONPath (`path`, arrays expand so any element matches) and 12 comparison operators (`op`: `eq`/`ne`/`contains`/`startsWith`/`endsWith`/`regex`/`gt`/`gte`/`lt`/`lte`/`in`/`exists`) extend the legacy glob/regex/case-insensitive-exact semantics; named filter fragments (D1 `d1_fragments` via `server/lib/fragments.ts`, per-group) are editor-side templates inlined into the route's `ast` on insert — the matcher never resolves fragment references; the route editor (`RouteEditor.vue`) exposes a recursive AST builder (`FilterNodeEditor.vue`), chip multi-value input (`TagInput.vue`), live explanation and a stateless `POST /admin/api/test-match` dry-run
- Local dev: wrangler + Miniflare

## Architecture

```text
app/                     # Vue 3 UI (Nuxt app dir)
├── app.vue              # root component (NuxtPage)
├── assets/css/main.css  # Tailwind v4 entry: Elysola-compatible RGB aliases + bespoke layout classes + Vue transition glue
├── pages/               # index (landing), terms, privacy, admin/[...slug] (console SPA)
├── components/          # ConsolePage (sidebar shell + topbar), AdminHome (overview dashboard),
│                        # RouteCard/Editor (RouteEditor has FilterNodeEditor AST builder + TagInput chips),
│                        # GroupEditor, MembersPanel, WebhookPanel,
│                        # SendLogs, AuditLog, MetricsPanel, AppToasts, LegalLayout
├── composables/         # useI18n, useToasts, useGroups, useGroupRoutes, useFilterNode (AST helpers), useFragments, useLogs, useAudit, useInvites, useWebhook
├── types.ts             # shared client types (Route, Group, Filter, ...)
└── utils/legal.ts       # terms/privacy HTML bodies (zh/en)
server/                  # Nitro server
├── routes/              # H3 handlers: /health, /webhook[/:groupId], /discord/interactions, /telegram/webhook,
│                        # /auth/github*, /admin/{login,logout,invite,api/**}, /api/{comment,merge,close,react,richheader}
├── tasks/               # scheduled (cron */5): discord-sync, telegram-sync, audit-prune, storage-prune
├── plugins/             # Nitro plugins: queue-consumer (hooks cloudflare:queue → handleQueueBatch)
├── error-handler.ts     # JSON error handler
└── lib/
    ├── types.ts         # Env, Config, Route, Filter, Group, WebhookEvent, NeutralMessage
    ├── config.ts        # loadRoutes/saveRoutes (delegates to D1 ConfigStore when available, else KV config:routes), loadConfig from env
    ├── fragments.ts     # named filter fragments (loadFragments/saveFragments — D1 d1_fragments, no KV)
    ├── config/          # config schema + migration + validation
    │   └── schema.ts    # CONFIG_SCHEMA_VERSION, valibot route/group/filter schemas, migrateRoutes/Groups, validateRoutes/Groups (non-destructive), explainRoute
    ├── cf.ts            # cfEnv(event) — env bindings from event.context.cloudflare
    ├── http.ts          # shared HTTP helpers
    ├── webhook.ts       # processWebhook/handleWebhook: tenant lookup, provider detect/verify/parse, dedup (D1/KV), enqueue (or inline dispatch)
    ├── queue/           # Cloudflare Queue delivery pipeline
    │   ├── delivery.ts  # DeliveryMessage, enqueueWebhook, retry backoff, delivery-state (D1 w/ KV fallback), payload-overflow parking (R2 → KV)
    │   └── consumer.ts  # handleQueueBatch: resolve payload → dispatch → classify → ack/retry/DLQ
    ├── core/
    │   └── dispatch.ts  # Platform-neutral dispatch: match routes → formatEvent → driver.send/edit (batched recordSend + group filter + per-group webhook log)
    ├── events/
    │   ├── match.ts     # matchRoute, eventOwners; unified pattern syntax (*/? globs + //-wrapped regex)
    │   └── filter-ast.ts # FilterNode evaluator (all/any/not + field JSONPath + 12 ops), containsKeyword, explainFilter/explainFilterNode; pattern helpers (regex/glob compile)
    ├── providers/       # Forge webhook providers (verify + parse/normalize to GitHub-shaped events)
    │   ├── types.ts     # Provider interface (matches/verify/parse)
    │   ├── hmac.ts      # HMAC-SHA256 + timing-safe compare helpers
    │   ├── index.ts     # detectProvider() registry (gitea, github, custom)
    │   ├── github/      # X-GitHub-Event + X-Hub-Signature-256 ("sha256=" prefix); extracts installation.id
    │   │   ├── verify.ts
    │   │   └── parse.ts
    │   ├── gitea/       # X-Gitea-Event + X-Gitea-Signature (plain hex HMAC)
    │   │   ├── verify.ts
    │   │   └── parse.ts # parse + normalize Gitea payloads to GitHub shape
    │   └── custom/      # X-WebHooker-Signature (sha256= HMAC) + arbitrary JSON → `custom` events
    ├── formatters/      # Platform-neutral message formatters (was formatter.ts)
    │   ├── index.ts     # formatEvent: builds FormatContext → findFormatter → .format (falls back to formatGeneric)
    │   ├── types.ts     # FormatContext + EventFormatter (formatter plugin interface)
    │   ├── registry.ts  # eventFormatters[] + findFormatter() — 29-event formatter plugin registry
    │   ├── colors.ts    # GITHUB_COLORS + WORKFLOW_CONCLUSION_EMOJI
    │   ├── helpers.ts   # emojiPrefix, T, buildMessage, commitLink/branchLink/tagLink
    │   └── *.ts         # push, pull-request, issues, comments, workflow, release, create,
    │                    # repo, check, review, commit-comment, deployment, member, label,
    │                    # milestone, discussion, repository, security, generic, ping, custom
    ├── drivers/         # Platform drivers (pluggable push targets)
    │   ├── types.ts     # PlatformDriver interface + SendResult (send + edit)
    │   ├── index.ts     # getDriver() registry (discord default + telegram + feishu)
    │   ├── discord/
    │   │   ├── index.ts       # DiscordDriver: send/edit → renderNeutralMessage + rest.sendMessage/editMessage
    │   │   ├── render.ts      # renderNeutralMessage: NeutralMessage → Discord FormattedMessage
    │   │   ├── rest.ts        # Discord REST sendMessage/editMessage with retry + rate-limit handling
    │   │   ├── interactions.ts # Ed25519 verify + interaction handlers (/gh, buttons, modals)
    │   │   └── commands.ts    # APP_COMMANDS + registerGlobalCommands/syncGuildCommands/syncCommands
    │   └── telegram/
    │       ├── index.ts      # TelegramDriver: send/edit → renderNeutralMessage + rest.sendMessage (avatar rich-header card)
    │       ├── render.ts     # renderNeutralMessage: NeutralMessage → Telegram HTML (parse_mode HTML)
    │       ├── rest.ts       # Telegram Bot API sendMessage/sendPhoto/editMessage* (chat_id + message_thread_id), retry
    │       ├── updates.ts    # POST /telegram/webhook: secret-token verify + handleTelegramUpdate
    │       └── commands.ts   # Telegram /gh login|logout|comment|merge|close + reply-message parsing + syncTelegramWebhook
│   └── feishu/
│       ├── index.ts      # FeishuDriver: send/edit → renderNeutralMessage + rest.sendMessage/updateMessage
│       ├── render.ts     # renderNeutralMessage: NeutralMessage → Feishu interactive card
│       ├── rest.ts       # getTenantAccessToken (KV cache) + sendMessage/updateMessage/sendText/updateCard, retry
│       └── updates.ts    # X-Lark-Signature verify + url_verification + /gh commands + card.action.trigger buttons
    ├── github/
    │   ├── oauth.ts     # OAuth URL, callback token exchange, getUserOctokit, comment/getComment/editComment/deleteComment/merge/close actions
    │   ├── app-token.ts # createAppJwt-backed getInstallationToken + GITHUB_API_VERSION (shared App auth)
    │   ├── check-run.ts # getCheckSuiteBuildLogUrl: Check-suite build-log enrichment (installation token)
    │   ├── workflow-jobs.ts # getWorkflowRunJobs: fetch a workflow_run's jobs via jobs_url (App token or unauthenticated)
    │   └── store.ts     # KV token CRUD + D1 discord-link/telegram-link mapping (was token-store.ts)
    ├── web/             # HTTP UI/API logic (called from server/routes)
    │   ├── oauth.ts     # handleOAuthStart/Callback, install page + bind, personal-group self-signup
    │   ├── actions.ts   # POST /api/comment|merge|close|react (Bearer token auth via shared middleware)
    │   ├── admin.ts     # adminLogin/Logout, adminApi* (routes|groups|me|logs|invites|audit|webhook|metrics|delivery)
    │   ├── auth.ts      # Shared auth middleware + guards: requireAnyAccess, requireGroup(Role), bearerUserId, clientIp
    │   ├── invites.ts   # Invite CRUD (KV invite:{token}, 7d TTL) + acceptInvite (join group as admin/viewer)
    │   ├── session.ts   # Session CRUD (KV session:{id}), isAdminUser, cookie helpers
    │   ├── groups.ts    # Group CRUD (config:groups), member roles (normalizeGroupMembers/memberRole), resolveScope + role helpers (roleAt/canEditRoutes/canEditGroup)
    │   ├── tenants.ts   # Per-group webhook secret CRUD (KV tenant:{groupId}, 32-byte random hex)
    │   └── richheader.ts # GET /api/richheader: Open Graph page for Telegram avatar link-preview card
    ├── observability/  # delivery metrics aggregation
    │   └── metrics.ts  # DeliveryMetrics + getDeliveryMetrics (SQL GROUP BY over send_logs: totals, per platform/event/status, duration, attempts, recent failures)
    ├── storage/        # storage primitives: canUseD1 probe, D1 config store (L1 memory → L2 KV cache → L3 D1), R2 payload store
    │   ├── d1.ts       # canUseD1(db) — prepare+batch probe for D1 availability (falls back to KV)
    │   ├── config-store.ts # ConfigStore (loadRoutes/saveRoutes/loadGroups/saveGroups/invalidateCache) backed by d1_groups/d1_routes, seeds from KV + syncs cache
    │   └── payload.ts  # PayloadStore backed by R2 (webhooks/YYYY/MM/DD/*.json), no-binding stub throws
    └── lib/             # shared infra
        ├── i18n.ts      # loadTranslations (KV i18n:{lang} overrides), t() with param interpolation
        ├── idempotency.ts # IdempotencyStore interface + kvIdempotencyStore/d1IdempotencyStore (delivery dedup via claim/has, D1 atomic UPSERT w/ KV fallback) + deliveryKey
        ├── correlation.ts # newCorrelationId() — per-request/delivery correlation id for logs + responses
        ├── message-tracker.ts # MessageTracker interface + kvMessageTracker/d1MessageTracker (msg:{eventId}:{targetId} for workflow_run/check_run edits)
        ├── send-log.ts  # SendRecord, recordSend/getSendLog/getSendLogById/getSendLogByDelivery/getFailedSendLog (D1 send_logs)
        ├── send-log-batch.ts # recordSendBatch (D1 batch INSERT for send_logs)
        ├── audit.ts     # recordAudit/getAuditLog/pruneAuditLogs (D1 audit_logs, best-effort writes)
        ├── log.ts       # JSON console logger (info/warn/error/fatal)
        └── locales/     # en.ts, zh.ts translation dictionaries

tests/                   # bun test unit tests (webhook, formatter, discord, telegram, admin, groups, invites, audit, send-log, token-store, ...)
tests/fixtures/          # provider payload fixtures (github/gitea/custom) feeding provider + formatter tests
tests/__snapshots__/     # formatter snapshot golden files (toMatchSnapshot)
```

## Responsibilities

- Verify GitHub webhook signatures (Web Crypto HMAC-SHA256, `X-Hub-Signature-256`)
- Verify Gitea webhook signatures (Web Crypto HMAC-SHA256, plain hex `X-Gitea-Signature`)
- Verify custom webhook signatures (Web Crypto HMAC-SHA256, GitHub-style `sha256=` via `X-WebHooker-Signature`; optional replay protection via `X-WebHooker-Timestamp` + `X-WebHooker-Nonce` — signature over `{timestamp}.{nonce}.{body}`, ±5 min window, nonce dedup in KV)
- Normalize Gitea webhook payloads to a GitHub-shaped `WebhookEvent` (push `compare_url` → `compare`, `pull_request_comment` → `pull_request_review_comment`, ...)
- Verify Discord interactions (Web Crypto Ed25519, X-Signature-Ed25519 over timestamp + body)
- Verify Telegram webhook calls (X-Telegram-Bot-Api-Secret-Token when configured)
- Filter events by: event type, repo name, actor, action, branch, keyword, or any payload field (`field` with a JSONPath `path` — arrays expand so any element matches) — every filter type supports `*`/`?` glob matching and `//`-wrapped regular expressions (case-insensitive) plus 12 comparison operators (`op`: `eq`/`ne`/`contains`/`startsWith`/`endsWith`/`regex`/`gt`/`gte`/`lt`/`lte`/`in`/`exists`)
- Combine filters into an AST (`Route.ast`: `all`/`any`/`not` nodes) that overrides the flat `filters` AND-list; `explainRoute`/`explainFilterNode` render a human-readable description of the tree
- Store named filter fragments (D1 `d1_fragments`, per group, `GET`/`PUT /admin/api/groups/:groupId/fragments`) as editor-side templates; inserting a fragment inlines its node into the route's `ast` — dispatch never resolves fragment references
- Offer a stateless filter dry-run (`POST /admin/api/test-match`, body `{ node | filters, event?, payload }`) that evaluates in memory and returns `{ matched, explanation }` — no event payload is stored
- Validate route/group config against valibot schemas on load (non-destructive: invalid entries log a warning but still load); `CONFIG_SCHEMA_VERSION` marks the schema version and `migrateRoutes`/`migrateGroups` migrate legacy shapes (e.g. `target` → `targets`)
- Filter routes by group owner restriction (`Group.owners`), group source-platform restriction (`Group.providers`: github/gitea), GitHub App installation restriction (`Group.installationId`), and skip fallback routes whenever a regular route matched; stop evaluating further routes when a matched route has `stop: true`
- Auto-provision GitHub App installs: the App's Setup URL flow (`/auth/github/install` choice page + `POST /auth/github/install/bind`, owner-role verified for existing groups) and the `installation.created` webhook fallback both create `inst-{installationId}` groups or bind existing groups
- Enforce role-based access on every admin API: super admins bypass, `owner` manages the group (routes/members/invites/settings), `admin` edits routes, `viewer` is read-only; legacy `adminIds` groups resolve to `owner` members
- Issue single-use 7-day group invite links (`invite:{token}`); accepting joins as admin/viewer (never owner); `ALLOW_SELF_SIGNUP=1` creates a deterministic personal group (`u-{userId}`) on first login
- Record every admin operation (login/logout, group/route/member/invite changes) to D1 `audit_logs`; the scheduled trigger prunes entries past `AUDIT_RETENTION_DAYS`
- Mention Discord roles on route trigger: route-level `discordRoleIds` are rendered as `<@&id>` into the Discord message `content` (Telegram targets ignore the field)
- Format 28 GitHub/Gitea event types plus `custom` webhooks as platform-neutral messages (Discord embeds + Telegram HTML)
- Show the forge source (named per `Group.forgeSources` host entries) in the message footer when the group defines a host matching the event's repository
- Route messages to Discord channels/threads and Telegram chats/topics via REST
- Edit already-sent messages in place for `workflow_run` / `check_run` progress (stable `updateKey`, `message_tracking` via D1 with KV `msg:*` fallback); `workflow_run` keys on the workflow id while `check_run` keys on check name + commit SHA (falling back to the run id) so providers that emit a fresh run id per phase — e.g. Cloudflare Pages — still edit the same message
- Record every dispatch attempt to D1 `send_logs` (route id, event, target, ok/error, duration, error code)
- Aggregate delivery metrics (`server/lib/observability/metrics.ts`) from `send_logs` — totals, ok/failed counts + failure rate, per-platform/per-event/per-status breakdowns, average duration and attempts, recent failures; `getDeliveryMetrics(db, groupId?)` scopes every query by `group_id` when a group is passed
- Expose admin observability endpoints — `GET /admin/api/metrics?groupId=` (delivery metrics, optional group scope; recent failures group-scoped for non-super) and `GET /admin/api/delivery/:deliveryId` (all send-log attempts for one delivery, group-scoped) — through the `/admin/api/[...slug]` catch-all route (`server/routes/admin/api/[...slug].ts`) that wires every admin API handler to its method+path
- Serve a per-group webhook ingress (`POST /webhook/{groupId}`, per-group secret in KV `tenant:{groupId}`) for Gitea/classic-GitHub/custom senders; only that group's routes fire; dedup keys are provider- and tenant-scoped (`delivery:{provider}:{groupId}:{id}` via `idempotencyStore`, D1 `dedup_keys` with KV fallback)
- Issue a per-request correlation id (`requestId`) in webhook responses and dispatch logs
- When the `QUEUE` binding is present, enqueue each verified webhook as a single Queue message (`webhooker-delivery`) instead of dispatching inline; the consumer resolves the payload, re-scopes routes to the tenant group, and dispatches; retryable failures (5xx/network/429-exhaustion) are retried with exponential backoff (5s/30s/2m/10m) up to the queue `max_retries`, then the DLQ marks the delivery dead
- Track delivery state in the D1 `delivery_state` table (`delivery-state:*` KV fallback: pending/processing/delivered/retrying/failed/dead) so redelivered messages are skipped idempotently; oversized payloads are parked in R2 (`webhooks/YYYY/MM/DD/*.json`, KV `queue:payload:*` fallback) and deleted after dispatch
- Prune expired D1 rows via the scheduled `storage-prune` task (dedup keys past expiry, delivery state older than 7 days, message tracking older than 30 days; audits via `audit-prune`)
- Send a per-event summary (event, repo, delivery id, per route×target ✅/❌ outcome) to the group's `logTarget` when configured
- Serve `/gh` slash commands + message context-menu commands + PR merge/close buttons + comment modals
- Serve Telegram `/gh` commands (login/logout/comment/merge/close) via reply-message parsing
- Serve Feishu `/gh` commands (login/logout/comment/merge/close) and card Merge/Close buttons via the `/feishu/webhook` endpoint (X-Lark-Signature verify + `url_verification` challenge)
- Sync application commands from the scheduled trigger (global ~1h propagation + per-guild instant)
- Sync the Telegram webhook URL from the scheduled trigger (setWebhook)

## Message Format Spec

- Every message title must start with the repo, then optional `#number`, then `: subject`:
  `{repo}{#number}: {subject}` (e.g. `acme/widget#7: Add feature`). Repo comes from
  `payload.repository.full_name`; fall back to `t("common.repository")` when missing.
- Only the repo head is hyperlinked (never the whole title). Drivers split the title via
  `splitMessageTitle` (`server/lib/formatters/helpers.ts`): the Discord embed title is
  `{repo}{#number}` linked to the event's object URL (`message.url`, e.g. the issue/PR/comment
  `html_url`) and `: {subject}` renders as the first description line; Telegram keeps the
  one-line title with an inline repo link and a plain subject. Messages without a colon
  separator (a `:` followed by a space) keep the legacy whole-title link — use colon-free
  wording for such titles.
- Do NOT use `"Comment on org/repo"` / `"Review on org/repo"` prefixes. Comments, reviews
  and inline comments use the same `{repo}{#number}: {title}` title as their parent object.
- All event-specific emoji live in `server/lib/formatters/` (via the `emojiPrefix` helper), never in
  the locale files. Emoji is controlled per group through the `Group.emoji` toggle (default true);
  `showEmoji=false` must strip every emoji from titles, descriptions, fields and links.
- Milestone progress bars (🟢🟡🟠⬜) are data visualization and are exempt from the emoji toggle.
- `workflow_run` messages render a **Jobs** field as a Discord `diff` fenced code block
  (`server/lib/formatters/workflow.ts`): one line per job, `${marker} ${name} ${emoji}${status}` plus
  `· {duration}` for completed jobs. `+` (green) for `success`, `-` (red) for other non-pending
  conclusions, a plain space for running/queued/pending; job names clamp to 200 chars and the field
  to the platform field limit. Drivers without diff support (Telegram, Feishu) collapse it to inline code.
- Commit hashes, branches and tags render as inline code wrapped in a hyperlink
  (`commitLink`/`branchLink`/`tagLink` helpers in `server/lib/formatters/helpers.ts`, e.g.
  ``[`abc123d`](https://.../commit/abc123def456)``, ``[`main`](https://.../tree/main)``),
  falling back to plain inline code when the repo base URL is unavailable.
- Content is clamped to the Discord embed limits (title 256, description 4096, field value
  1024, 25 fields) both in the formatters and as a final safety net in the Discord render;
  the Telegram render caps the whole message at 4096 chars with tag-safe truncation. Commit
  subjects render only the first line, truncated to 200 chars.
- Locale templates use a `{emoji}` placeholder immediately followed by the text (no space);
  the formatter injects `em(...)` which carries the trailing space.

## Development

Package manager is **bun** — never use `npm`/`npx` (no `package-lock.json`, lockfile is `bun.lock`; CI runs `bun install --frozen-lockfile`).

```bash
bun install           # Install dependencies (updates bun.lock)
bun run dev           # Nuxt dev (HMR + Nitro dev server)
bun run build         # Production build (nuxt build, cloudflare_module preset)
bunx wrangler dev     # Miniflare preview of a built worker (bun run build first)
bun run typecheck     # Type checking (nuxt typecheck)
bun run lint          # ESLint
bun test              # Unit tests (under tests/)
```

Test suites beyond the per-module unit tests: provider fixtures (`tests/fixtures/` +
`tests/provider-fixtures.test.ts`), formatter snapshots (`tests/formatter-snapshot.test.ts` →
`tests/__snapshots__/`), and platform contract tests (`tests/platform-contract.test.ts`, which
assert the Discord/Telegram renderers clamp to their platform limits). CI
(`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile` + `bun test` + `bun run lint`;
CodeQL (`codeql.yml`) and Dependabot (`dependabot.yml`) are configured under `.github/`.

## Documentation

Keep every functional change in sync with the docs. After implementing a feature, fix,
or refactor, update all of the following that are affected:

- `AGENTS.md` (this file) — architecture tree, responsibilities, key decisions, config
- `README.md` / `README.zh.md` — features, setup, configuration, supported events
- `docs/` (VitePress) — both `docs/` (English) and `docs/zh/` (Chinese) mirrors
- `config.example.yaml` / `.env.example` — example config/secret files

Rule: no functional change ships without its documentation; docs and code must not drift.

## Configuration

- **Local dev**: `.dev.vars` (wrangler reads this for env bindings)
- **Production**: `wrangler secret put <NAME>` for each secret
- **Routes**: config in D1 `d1_routes`/`d1_groups` (authoritative), seeded from legacy KV `config:routes`/`config:groups` on first load; cache-only KV keys
- **KV namespace**: Required binding for token/state/session/cache storage (dedup/delivery-state/message-tracking fall back to KV when D1 is unavailable)
- **D1 database**: Binding `DB` (database `webhooker`, id `214a0104-3235-47c0-b7bf-ddda95f3c8ac`) for `send_logs` + `audit_logs` + `discord_links` + `telegram_links` + `d1_groups` + `d1_routes` + `d1_fragments` + `dedup_keys` + `delivery_state` + `message_tracking` tables
- **Queue**: optional `QUEUE` producer binding plus consumers `webhooker-delivery` and its DLQ `webhooker-delivery-dlq` (declared in `wrangler.jsonc`); when absent, webhook dispatch stays inline
- **R2**: optional `PAYLOAD` binding (bucket `webhooker-payloads`) for oversized queue payloads; without it, oversized payloads fall back to KV `queue:payload:*`
- **Access control**: `ADMIN_USER_IDS` (super admins), `DEBUG_MODE=true` (local-only authentication bypass), `ALLOW_SELF_SIGNUP` (optional personal group on first login), `AUDIT_RETENTION_DAYS` (default 90) — all plain env vars, not secrets
- **Discord**: `DISCORD_PUBLIC_KEY` (Interactions Endpoint signature verification, from Discord Developer Portal) and `DISCORD_APPLICATION_ID` (optional, auto-resolved via `GET /oauth2/applications/@me` when omitted) are required for interactions
- **Telegram**: `TELEGRAM_TOKEN` (Bot API token from BotFather) required for Telegram routes; `TELEGRAM_WEBHOOK_SECRET` (optional secret token for `POST /telegram/webhook` verification); avatars are sent as a link-preview card via the built-in `GET /api/richheader` (overridable with `TELEGRAM_RICH_HEADER_HOST`)
- **Webhook providers**: `GITEA_WEBHOOK_SECRET` (required to receive Gitea webhooks; Gitea signs `X-Gitea-Signature` with the hex HMAC-SHA256 of the body)

## Deployment

```bash
bunx wrangler secret put GITHUB_WEBHOOK_SECRET
bunx wrangler secret put DISCORD_TOKEN
bunx wrangler secret put DISCORD_PUBLIC_KEY
bunx wrangler kv namespace create KV
# Update wrangler.jsonc with KV ID
bunx wrangler d1 create webhooker
# Update wrangler.jsonc d1_databases with the database ID
bunx wrangler queues create webhooker-delivery
bunx wrangler queues create webhooker-delivery-dlq
# Queues are declared in wrangler.jsonc (QUEUE binding); no env var needed
bun run db:migrate:prod   # wrangler d1 migrations apply webhooker --remote (migrations/0001..0010)
# R2 bucket for oversized payloads (P0): bunx wrangler r2 bucket create webhooker-payloads
bunx wrangler deploy
```

Full list of secrets used: `GITHUB_WEBHOOK_SECRET`, `GITEA_WEBHOOK_SECRET`,
`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`
(PKCS#8 PEM), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `DISCORD_TOKEN`,
`DISCORD_PUBLIC_KEY`, `TELEGRAM_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ADMIN_USER_IDS`, `DEBUG_MODE`,
plus optional `BASE_URL`, `DISCORD_APPLICATION_ID`, `TELEGRAM_RICH_HEADER_HOST`,
`NUXT_PUBLIC_DOCS_URL`, `NUXT_PUBLIC_REPO_URL`, `NUXT_PUBLIC_LEGAL_CONTACT`. See `.env.example` and `docs/guide/configuration.md`.

## Notes

- Commands sync from the scheduled trigger (`*/5 * * * *`): registered per-guild for instant availability and globally (24h dedup, ~1h propagation).
- The bot is always offline (no Discord Gateway); interactions arrive via the HTTP endpoint.
