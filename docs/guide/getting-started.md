# Getting Started

## Prerequisites

- [Bun](https://bun.sh/) 1.x (the only package manager; never use npm)
- A [Cloudflare account](https://dash.cloudflare.com/) (free tier works)
- A [GitHub App](https://github.com/settings/apps/new) (see [GitHub App Setup](/guide/deployment#github-app-setup))
- A Discord bot token (see [Discord Bot Setup](/guide/deployment#discord-bot-setup))

## Installation

```bash
git clone https://github.com/Elysola/WebHooker.git
cd WebHooker
bun install
```

## Local Development

### 1. Configure Secrets

Copy the example env file and fill in your secrets:

```bash
cp .env.example .dev.vars
```

Edit `.dev.vars` with your actual values:

```bash
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
DISCORD_TOKEN=your-bot-token
DISCORD_PUBLIC_KEY=your-public-key
ADMIN_USER_IDS=your-github-id,your-github-login
BASE_URL=http://localhost:8787
```

::: tip
`GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` are optional and only used by the App install flow to resolve the installing account's login (the OAuth flow only needs the client ID/secret). Target channels are set per route in the Web UI, so no `DISCORD_CHANNEL_ID` is needed. To enable `/gh` commands locally, copy the **Public Key** from the Developer Portal into `DISCORD_PUBLIC_KEY` and set the Interactions Endpoint URL to `http://localhost:8787/discord/interactions`.
:::

::: warning
`.dev.vars` is gitignored and contains secrets. Never commit it.
:::

### 2. Start Dev Server

```bash
bun run dev
```

This starts a local Miniflare environment at `http://localhost:8787`.

### 3. Verify

```bash
curl http://localhost:8787/health
# → {"status":"ok"}
```

## Available Scripts

| Script                 | Description                                 |
| ---------------------- | ------------------------------------------- |
| `bun run dev`          | Start Nuxt dev server (HMR)                 |
| `bun run build`        | Production build (cloudflare_module preset) |
| `bun run deploy`       | Deploy to Cloudflare                        |
| `bun run typecheck`    | TypeScript type checking                    |
| `bun run lint`         | ESLint                                      |
| `bun run lint:md`      | Markdownlint                                |
| `bun run format`       | Format with Prettier                        |
| `bun run format:check` | Check Prettier formatting                   |
| `bun test`             | Unit tests                                  |
| `bun run docs:dev`     | Start docs dev server                       |
| `bun run docs:build`   | Build docs site                             |
