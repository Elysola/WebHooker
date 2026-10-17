---
layout: home

hero:
  name: WebHooker
  text: GitHub / Gitea Webhook → Discord
  tagline: Receive GitHub and Gitea events via Cloudflare Workers, apply filters, and route formatted messages to Discord channels/threads and Telegram chats/topics.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/Elysola/WebHooker

features:
  - title: 28 Event Formatters
    details: Rich Discord embeds and Telegram HTML for push, pull_request, issues, release, workflow_run, and 23 more event types with color-coded output.
  - title: Flexible Filtering
    details: Filter by event type, repo, actor, action, branch (including PRs), and keyword (with regex support). Exclude patterns with a flag.
  - title: Cloudflare Workers
    details: Runs on Cloudflare's edge network. Sends via the Discord REST API and Telegram Bot API, with an Ed25519-verified Interactions Endpoint for `/gh` slash commands and buttons.
  - title: Web UI, Groups & Commands
    details: "Manage routes, groups and send logs from a built-in admin console. Link your GitHub account and comment on issues/PRs as yourself via /gh commands on Discord or Telegram."
  - title: Signature Verification
    details: Provider-aware HMAC-SHA256 webhook signature verification (GitHub X-Hub-Signature-256, Gitea X-Gitea-Signature) and Ed25519 interaction signature verification using the Web Crypto API with timing-safe comparison.
  - title: In-Place Updates
    details: workflow_run and check_run progress are edited in place on a single message as the run advances, on both Discord and Telegram.
---
