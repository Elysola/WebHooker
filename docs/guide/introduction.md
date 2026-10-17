# Introduction

WebHooker is a GitHub/Gitea webhook dispatcher built on Cloudflare Workers. It receives webhook events from supported forges (GitHub, Gitea — more can be added via `server/lib/providers/`), applies configurable filters, formats them into rich messages, and delivers them to Discord channels/threads (embeds) and Telegram chats/topics (HTML) via their REST APIs. In-Discord `/gh` interactions arrive via an HTTPS Interactions Endpoint (Ed25519-verified); Telegram `/gh` commands arrive via the Telegram webhook. Routes and groups are managed through a built-in Web UI.

## Architecture

```text
GitHub / Gitea Webhook → Cloudflare Worker (Nuxt 4 / Nitro)
                 ├── POST /webhook → detect provider → verify → dedup → filter → format → Discord (REST) / Telegram (Bot API)
                 ├── POST /discord/interactions → verify (Ed25519) → handle /gh slash & context commands
                 ├── POST /telegram/webhook → verify (secret token) → handle /gh commands
                 ├── GET  /auth/github → OAuth flow
                 ├── GET  /api/richheader → Telegram avatar link-preview card
                 ├── POST /api/* → user actions (Bearer token auth)
                 ├── /admin → routes, groups & send-log Web UI (admin session)
                 └── GET  /health → status check
```

### Components

| Component                 | Role                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare Worker**     | HTTP ingress, signature verification, delivery dedup, event parsing, route matching, platform dispatch                                                                                                                                                                                                                       |
| **Interactions Endpoint** | Verifies Ed25519 signatures and handles `/gh` interactions (slash commands, context-menu commands, buttons, modals)                                                                                                                                                                                                          |
| **KV**                    | Token storage (`token:{userId}`), OAuth state (`state:{hex}`), admin sessions, per-group secrets, config cache, delivery dedup/state/message-tracking fallback when D1 is unavailable (`delivery:*`, `delivery-state:*`, `msg:*`), message-update locks (`msg:lock:*`)                                                       |
| **D1**                    | Routes/groups (`d1_routes`/`d1_groups`), send logs (`send_logs`), audit logs (`audit_logs`), dedup (`dedup_keys`), delivery state (`delivery_state`), message tracking (`message_tracking`), Discord↔GitHub links (`discord_links`), Telegram↔GitHub links (`telegram_links`), with R2 optionally parking oversized payloads |

### Data Flow

1. A forge (GitHub or Gitea) sends a webhook to `POST /webhook`
2. Worker detects the provider from its headers (`X-GitHub-Event` / `X-Gitea-Event`) and verifies the provider-specific HMAC-SHA256 signature
3. Worker deduplicates by the delivery id (D1, short TTL, KV fallback) to drop repeat deliveries
4. Worker parses the event type and normalizes the payload to a GitHub-shaped event
5. Routes are evaluated against filters (event, repo, actor, action, branch, keyword) and group owner restrictions
6. Matching routes trigger formatter functions that produce platform-neutral messages
7. Each message is sent to its route's target(s) via the Discord or Telegram REST API with rate-limit retry; `workflow_run` / `check_run` progress is edited in place. Every attempt is recorded in the D1 send log

## Tech Stack

- **Runtime**: Cloudflare Workers
- **HTTP Framework**: Nuxt 4 / Nitro (H3)
- **Discord delivery**: Discord REST API (interactions via an Ed25519-verified HTTPS Interactions Endpoint)
- **Telegram delivery**: Telegram Bot API (webhook with optional secret-token verification)
- **Web UI**: Nuxt 4 (Vue 3 + Tailwind CSS v4 + `@elysola/ui`) — server-rendered home/legal pages, client-side `/admin` console
- **Storage**: Cloudflare D1 (authoritative for config & logs) + KV (cache/transient state) + optional R2 (oversized payloads)
- **Auth**: Web Crypto API (HMAC-SHA256, Ed25519), octokit (GitHub API)
- **Language**: TypeScript

## License

MIT
