# Deployment

## Cloudflare Setup

`wrangler.jsonc` ships with the maintainers' `account_id` and resource ids. Replace `account_id` with your own Cloudflare account id (`bunx wrangler whoami`), or remove the field to deploy to the account you are logged in with, and replace the ids in the steps below.

### 1. Create KV Namespace

```bash
bunx wrangler kv namespace create KV
```

This outputs a namespace ID. Update `wrangler.jsonc` with the ID:

```jsonc
{
  "kv_namespaces": [
    {
      "binding": "KV",
      "id": "your-namespace-id",
    },
  ],
}
```

### 2. Set Secrets

```bash
bunx wrangler secret put GITHUB_WEBHOOK_SECRET
bunx wrangler secret put GITHUB_CLIENT_ID
bunx wrangler secret put GITHUB_CLIENT_SECRET
bunx wrangler secret put DISCORD_TOKEN
bunx wrangler secret put DISCORD_PUBLIC_KEY   # Discord app public key (Developer Portal) — required for interactions
bunx wrangler secret put TELEGRAM_TOKEN       # Telegram bot token (BotFather) — required for Telegram routes
bunx wrangler secret put FEISHU_APP_ID        # Feishu app ID — required for Feishu routes
bunx wrangler secret put FEISHU_APP_SECRET    # Feishu app secret — required for Feishu routes
bunx wrangler secret put ADMIN_USER_IDS       # comma-separated GitHub user ids allowed into the Web UI (numeric ids recommended)
bunx wrangler secret put BASE_URL             # public URL of the worker — OAuth callbacks and the Telegram webhook sync need it
```

::: tip Target channels are configured per route
There is no global channel secret. Each route in the [Web UI](/guide/configuration#web-ui) declares its own target channel (and optional thread), so `DISCORD_CHANNEL_ID` is not needed.
:::

::: tip GitHub App ID / private key are optional
`GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY` (PKCS#8 PEM) are used by the [App install flow](#github-app-setup) to resolve the installing account's login on the post-install choice page, and to mint installation tokens for API enrichment — fetching `workflow_run` job lists and check-suite build logs. Without them only super admins can bind installations — the flow cannot resolve the installation's account, so it cannot verify that a signed-in user manages it — workflow job lists still load for public repositories (unauthenticated), and private-repo build logs are omitted. The OAuth flow only needs `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.
:::

Discord interactions arrive via the HTTPS Interactions Endpoint, so set `DISCORD_PUBLIC_KEY` and point the **Interactions Endpoint URL** at `https://your-domain/discord/interactions`. See [Interactions Endpoint](#interactions-endpoint) below.

### 3. Create D1 Database and Run Migrations

```bash
bunx wrangler d1 create webhooker
```

Copy the returned database ID into `wrangler.jsonc`:

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "webhooker",
      "database_id": "your-database-id",
    },
  ],
}
```

Then apply the migrations:

```bash
bun run db:migrate:prod   # apply migrations to the remote D1 database
bun run db:migrate        # apply migrations to the local (Miniflare) database
```

The `db:migrate` scripts run `wrangler d1 migrations apply webhooker` (see `package.json`), which applies each SQL file in `migrations/` and records applied versions in the `d1_migrations` table. `bun run deploy` runs `db:migrate:prod` before deploying, so migrations added later are applied on the next deploy; already-applied ones are skipped, and a failed migration stops the deploy.

::: tip Databases previously migrated with `d1 execute`
If the database already has these tables/columns (e.g. previously migrated with `wrangler d1 execute --file`), the `d1_migrations` tracking table may be missing and `db:migrate:prod` will try to re-run every migration. The `ALTER TABLE ... ADD COLUMN` statements in `0002_log_detail.sql` then fail because the columns already exist. In that case apply the files your database does not have yet directly (the `ALTER TABLE ... ADD COLUMN` files fail when run twice, so skip those already applied):

```bash
bunx wrangler d1 execute webhooker --remote --file ./migrations/0001_init.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0002_log_detail.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0003_telegram_links.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0004_add_group_id.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0005_audit_logs.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0006_config_d1.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0007_send_logs_index.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0008_storage_d1.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0010_fragments.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0011_feishu_links.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0012_route_position.sql
bunx wrangler d1 execute webhooker --remote --file ./migrations/0013_prune_indexes.sql
```

Such a database has no migration history, so `bun run deploy` (which runs `db:migrate:prod` first) would try every migration again and stop. Deploy it with `bunx wrangler deploy`, and apply later migration files the same way.

:::

### 4. Create R2 Bucket (Optional)

The `PAYLOAD` binding parks oversized webhook payloads in R2 (`webhooker-payloads`) instead of KV. Without it, oversized payloads fall back to the KV key `queue:payload:*`. See [Storage](/guide/storage) for the layout.

```bash
bunx wrangler r2 bucket create webhooker-payloads
```

Then uncomment the `r2_buckets` block in `wrangler.jsonc` (it ships commented out); without the binding, oversized payloads stay in KV.

### 5. Create Queues (Optional)

The `QUEUE` binding routes webhook delivery through Cloudflare Queues (async dispatch with retry backoff and a dead-letter queue). To keep dispatch inline (synchronous) instead, remove or comment out the `queues` block in `wrangler.jsonc`; while it is there, both queues must exist.

```bash
bunx wrangler queues create webhooker-delivery
bunx wrangler queues create webhooker-delivery-dlq
```

The queues are already declared in `wrangler.jsonc` (`queues.producers` / `queues.consumers`), so no binding change is needed. The `webhooker-delivery` consumer retries retryable failures (5xx, 429, network, rate-limit exhaustion, Feishu token errors) with exponential backoff (5s/30s/2m/10m) up to `max_retries`, after which the message is moved to `webhooker-delivery-dlq` and marked dead. Retries are per target: targets that already succeeded — or failed permanently — are recorded and not attempted again, so one bad target never cancels the others' retries and a retry does not resend a recorded target (a send whose record could not be written may be repeated). Each consumer invocation takes at most 3 messages and shares a budget of 12 minutes and 20 target sends across them, because the Workers Free limits (50 D1 queries, 50 subrequests) apply per invocation: a message the budget did not reach is retried, and a delivery with more targets than the budget continues in a new queue message. A delivery whose every target was handled still ends as `failed` if any target failed permanently along the way. A delivery is taken with a 5-minute lease, so two consumers never dispatch the same delivery at once.

> [!NOTE]
> R2 has no per-object TTL. Parked payloads are deleted after dispatch, and the scheduled `storage-prune` task removes orphans older than five days; you may also add a bucket [lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) for the `webhooks/` prefix.

### 6. Deploy

```bash
bun run deploy   # applies pending D1 migrations, then runs wrangler deploy
```

Run from a terminal, wrangler asks for confirmation before applying pending migrations; in CI it proceeds. If you deploy through Cloudflare's Git integration (Workers Builds), set its deploy command to `bun run deploy` so migrations are applied there too.

Your worker is now live at `https://webhooker.<your-subdomain>.workers.dev`.

### 7. Configure GitHub Webhook

1. Go to your GitHub App settings
2. Set **Webhook URL** to `https://webhooker.<your-subdomain>.workers.dev/webhook`
3. Set **Webhook secret** to match `GITHUB_WEBHOOK_SECRET`

### 8. (Optional) Configure Gitea Webhook

1. In your Gitea repo, go to **Settings → Webhooks → Add Webhook → Gitea**
2. Set **Target URL** to `https://webhooker.<your-subdomain>.workers.dev/webhook`
3. Set **HTTP Method** to `POST` and **Content Type** to `application/json`
4. Set **Secret** to match `GITEA_WEBHOOK_SECRET`
5. Choose the events to trigger (push, issues, pull requests, releases, ...)

## GitHub App Setup

### 1. Create App

1. Go to <https://github.com/settings/apps/new>
2. Fill in:
   - **GitHub App name**: `WebHooker` (or your choice)
   - **Homepage URL**: your domain
   - **Webhook URL**: `https://your-domain/webhook`
   - **Webhook secret**: generate and copy to `GITHUB_WEBHOOK_SECRET`
3. Set permissions:
   - **Repository permissions**: Contents (read), Issues (write), Pull requests (write), Metadata (read), Checks (read), Actions (read), Deployments (read), Discussions (read), Code scanning alerts (read), Dependabot alerts (read)
   - **Organization permissions**: Members (read) — if needed
4. Subscribe to events (all 28 supported):
   - Push, Pull request, Issues, Issue comment, Workflow run, Workflow job, Status, Deployment, Deployment status, Ping, Release, Create, Delete, Star, Fork, Check run, Check suite, Pull request review, Pull request review comment, Commit comment, Member, Label, Milestone, Discussion, Discussion comment, Repository, Code scanning alert, Dependabot alert
5. Generate a private key and set `GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY`: the install flow needs them to verify that the installing user manages the installation (without them only super admins can bind installations), and API enrichment (workflow job lists, build logs) uses them for private repositories (see the tip above).

### 2. Install App

1. After creation, go to the App settings page
2. Click "Install App" → select org/user
3. Choose repositories to monitor

### 3. Configure OAuth

1. Go to App → OAuth settings
2. Set **Callback URL**: `https://your-domain/auth/github/callback`
3. Copy Client ID and Client Secret to env

## Discord Bot Setup

1. Go to <https://discord.com/developers/applications>
2. Create a new application → go to Bot section
3. Copy the bot token to `DISCORD_TOKEN`
4. Invite the bot with the `bot` and `applications.commands` scopes and the `View Channels` + `Send Messages` + `Send Messages in Threads` permissions (combined integer `274877910016`):

   ```text
   https://discord.com/oauth2/authorize?client_id=YOUR_BOT_CLIENT_ID&permissions=274877910016&scope=bot+applications.commands
   ```

5. Configure target channels **per route** in the Web UI (`/admin`) — no global channel ID is required.

### Interactions Endpoint

Messages are sent via the Discord **REST API**, so pushing works with just `DISCORD_TOKEN`. Interactions (slash commands, buttons, modals) arrive through the HTTPS Interactions Endpoint:

1. Copy the application **Public Key** (Developer Portal → General Information) to `DISCORD_PUBLIC_KEY`.
2. Set the **Interactions Endpoint URL** to `https://your-domain/discord/interactions`.
3. Every interaction request is verified with Ed25519 signatures (`X-Signature-Ed25519` over `X-Signature-Timestamp + body`).

The `/gh` slash command and the `GitHub: 添加/编辑/删除评论` message commands are synced by the scheduled trigger (every 5 minutes): per-guild for instant availability (at most 30 API calls per run), plus a global registration (~1h propagation); both are registered again when the command definitions change. The bot never connects to the Discord Gateway, so it shows as **offline** — messaging is unaffected (always REST).

Users run `/gh login` to link their GitHub account and can then comment on issues/PRs as themselves. See the [Bot Commands](/guide/commands) page for the full command reference.

## Telegram Bot Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token to `TELEGRAM_TOKEN`.
2. (Optional) Set `TELEGRAM_WEBHOOK_SECRET`; the webhook registration passes it to Telegram as `secret_token`, and `POST /telegram/webhook` verifies it with a timing-safe compare. When unset, a secret derived from `TELEGRAM_TOKEN` is used instead, so the endpoint is never left unauthenticated (the next scheduled sync re-registers the webhook with it).
3. The worker syncs the webhook from the scheduled trigger (`setWebhook` to `{BASE_URL}/telegram/webhook`, only when the registration changed and once a day), so no manual `setWebhook` call is needed — just make sure `BASE_URL` is set.
4. Add the bot to a group (or enable topics) and route events to `chatId` / `topicId` in the route config. Use the numeric chat id (e.g. `-1001234567890`); `@username` targets are not accepted.

In Telegram, `/gh` commands (`/gh login`, `/gh logout`, `/gh comment <text>`, `/gh merge`, `/gh close`) work by replying to a notification message — see the [Bot Commands](/guide/commands) page. `/gh login` only works in the private chat with the bot, and the GitHub user confirms the binding on a page that names both accounts.

Avatars are rendered as a link-preview card using the built-in `GET /api/richheader` (overridable with `TELEGRAM_RICH_HEADER_HOST`; without `BASE_URL` the avatar image itself is the preview). Messages are always text messages, so in-place updates keep the full 4096-character budget.

## Feishu Bot Setup

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) → **Create App** → choose **Custom App** → give it a name.
2. In **Credentials & Basic Info**, copy **App ID** and **App Secret** to `FEISHU_APP_ID` and `FEISHU_APP_SECRET`.
3. In **Permissions & Scopes**, add at least one of the following message scopes so the app can send (and read) messages:
   - `im:message` (read and send direct messages and group chat messages)
   - `im:message:send_as_bot` (send messages as an app)
   - `im:message:send` (historical version)
4. In **Bot** tab, turn on the bot capability. Add the bot to the target group chat (or create a new group) and copy the **Chat ID** from the group settings.
5. In WebHooker `/admin`, create or edit a route and add a target with `platform: "feishu"` and `chatId` set to the Feishu **Chat ID** (`oc_…`); Feishu targets have no topic.

WebHooker uses the app-level credentials (`FEISHU_APP_ID` / `FEISHU_APP_SECRET`) to request a `tenant_access_token`, caches it per app (in memory and KV) until shortly before it expires, drops it as soon as Feishu refuses it, and sends messages as an interactive card (`interactive` message type). The same token is used to edit messages in place for `workflow_run` / `check_run` progress updates.

### Inbound: commands & buttons

WebHooker can receive Feishu events and let users act on PRs/Issues from chat, the same way as Discord and Telegram:

- `/gh login` — link your GitHub account (opens an OAuth page).
- `/gh logout` — unlink your GitHub account.
- `/gh comment <PR/Issue 链接> <内容>` — comment as your linked GitHub user.
- `/gh merge <PR 链接>` / `/gh close <PR 链接>` — merge / close the PR as your linked user.
- The **Merge** / **Close** buttons on a card trigger the same actions.

To enable inbound:

1. In the app **Events & Callbacks** → **Event Subscriptions**, set the **Request URL** to `https://<your-worker>/feishu/webhook` (Feishu will send a `url_verification` challenge, which WebHooker answers automatically).
2. Subscribe to the events:
   - `im.message.receive_v1` — receive `/gh` commands (requires the `im:message` scope).
   - `card.action.trigger` — receive button clicks on cards.
3. In **Events & Callbacks → Encryption Strategy**, copy the **Encrypt Key** to `FEISHU_ENCRYPT_KEY` (WebHooker then verifies `X-Lark-Signature` — SHA-256 of timestamp + nonce + key + body — and decrypts encrypted callbacks) and/or the **Verification Token** to `FEISHU_VERIFICATION_TOKEN`. At least one is required; without them every callback is refused. Each event id runs once, even when Feishu retries it.
4. `/gh login` only works in the private (p2p) chat with the bot; the GitHub user confirms the binding on a page that names both accounts.

### Required permissions

| Permission               | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `im:message`             | Read and send direct messages and group chat messages.     |
| `im:message:send_as_bot` | Send messages as an app bot (alternative to `im:message`). |
| `im:message:send`        | Send messages V2 (historical version, alternative).        |

> [!NOTE]
> Custom bots (group-level webhook URL) are not supported. WebHooker uses an **app bot** so message editing, token caching, multi-group routing, and inbound commands work the same way as Discord and Telegram.

## Custom Domain (Optional)

To use a custom domain instead of `*.workers.dev`:

1. Go to your Cloudflare Worker settings
2. Add a custom domain or route
3. Update `BASE_URL` to match

> [!NOTE]
> This project is a Cloudflare Worker. It requires the KV and D1 bindings declared in `wrangler.jsonc`, so it cannot run as a standalone Node/container process. The Queues binding (`QUEUE`) is optional — without it, webhook dispatch stays inline.
