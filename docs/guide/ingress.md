# Webhook Ingress & Tenancy

## Webhook Providers

WebHooker ingests webhooks from multiple forges through the same `POST /webhook` endpoint; the provider is auto-detected from the request headers, so point every forge's webhook at `{BASE_URL}/webhook`.

| Provider | Event header     | Signature header      | Signature format           | Secret                  |
| -------- | ---------------- | --------------------- | -------------------------- | ----------------------- |
| GitHub   | `X-GitHub-Event` | `X-Hub-Signature-256` | `sha256=<hex>` HMAC-SHA256 | `GITHUB_WEBHOOK_SECRET` |
| Gitea    | `X-Gitea-Event`  | `X-Gitea-Signature`   | plain hex HMAC-SHA256      | `GITEA_WEBHOOK_SECRET`  |

Delivery-id dedup uses `X-GitHub-Delivery` (GitHub) or `X-Gitea-Delivery` (Gitea) when present.

With the delivery queue enabled, a webhook is acknowledged (`200`) only after it was durably enqueued. If the queue rejects it, the endpoint answers `503` and releases the dedup claim, so the sender's redelivery is accepted instead of being dropped as a duplicate. A redelivery of a webhook that was already accepted answers `200 { "duplicate": true }`; one that arrives while the first copy is still being processed answers `503`, so the sender tries again later.

Without the queue binding, the webhook is dispatched inline and answered only once dispatch finished: `200` when every target was handled, `503` when a target failed transiently (the sender's redelivery then skips the targets that already succeeded). Inline dispatch stops sending after 8 minutes and answers `503` for the rest, so one request never outlives its dedup claim.

Gitea payloads are normalized to the same internal shape as GitHub events, so routes, filters, and the 28 formatters work unchanged. Unknown or unmapped Gitea events fall back to the generic formatter. Repository/commit/user links are derived from the payload's `repository.html_url`, so they point at your Gitea instance.

## Global Endpoint (`POST /webhook`)

The global endpoint verifies payloads against the operator's global secrets (`GITHUB_WEBHOOK_SECRET`, `GITEA_WEBHOOK_SECRET`) and dispatches into **all** routes — except those of [isolated groups](./groups#self-sign-up) without a bound source. GitHub App installations deliver here; use `installationId` on groups to keep tenants isolated.

## Per-Group Endpoint (`POST /webhook/{groupId}`)

Every group can opt into its own webhook ingress with an independent secret (generated from the group page — Webhook endpoint panel, owner role). Payloads are verified against the **group's** secret instead of the global ones, and only that group's routes are eligible. This is how SaaS users configure Gitea, classic GitHub, or custom webhooks without sharing (or knowing) the operator's secrets.

- Supported for any provider: GitHub (`X-Hub-Signature-256`), Gitea (`X-Gitea-Signature`), custom (`X-WebHooker-Signature`)
- The secret is a 64-char hex string stored with the group in D1 (it is never sent to the console after generation); regenerating invalidates the old one immediately, and only a current owner can rotate or remove it
- Delivery-id dedup keys are provider- and tenant-scoped (`delivery:{provider}:@i:{instance}:{id}` — the group's immutable instance, so a rename keeps the scope and a group re-created under the same id never shares it; the global endpoint uses the scope `@global`)
- When the group has no secret (or no longer exists) the endpoint returns `404`; when the group's stored configuration cannot be read it returns `503`
- A tenant-signed payload is only as trustworthy as the tenant: its `installation.id` is ignored, so it never uses the operator's GitHub App credentials (no job/build-log enrichment) and never provisions or rebinds installation groups; the installation restriction does not apply to the group's own ingress

## Custom Webhooks

Post a JSON object to `POST /webhook/{groupId}` (or the global endpoint) with the body signed as `X-WebHooker-Signature: sha256=<hmac-sha256 hex of the raw body>` using the group's secret (a top-level array or scalar is rejected with `400`). The payload becomes a `custom` event that flows through the normal route pipeline — create a route with `event: custom` (there is a console template) and it dispatches to that route's targets, records `send_logs`, and appears in the group's webhook log channel.

### Replay Protection

Custom webhooks support optional replay protection via two extra headers alongside the signature:

- `X-WebHooker-Timestamp` — Unix seconds the request was sent
- `X-WebHooker-Nonce` — a unique, unpredictable value per request (e.g. a UUID)

When **both** headers are present, the signature is computed over `{timestamp}.{nonce}.{rawBody}` instead of the raw body, and the request is accepted only if:

1. The timestamp is within ±5 minutes of the server clock (rejects replays and clock-drift abusers)
2. The nonce has never been seen before for this secret (claimed atomically and kept for 10 minutes; a replayed nonce is rejected, while another tenant may use the same nonce). A nonce whose first request is still being processed, or a failure of the nonce store, answers `503` instead of `401`, so the sender retries

```bash
input="${timestamp}.${nonce}.${body}"
signature="sha256=$(printf '%s' "$input" | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/.*= //')"
```

When the headers are omitted, WebHooker falls back to the legacy body-only signature, so existing senders keep working unchanged.

Payload schema:

```json
{
  "title": "Deploy failed",
  "description": "Prod rollout failed at 12:03 UTC",
  "color": "red",
  "url": "https://ci.example.com/runs/42",
  "repo": "acme/widget",
  "author": {
    "name": "alice",
    "iconUrl": "https://…/alice.png",
    "url": "https://github.com/alice"
  },
  "fields": [{ "name": "Env", "value": "prod", "inline": true }],
  "footer": "my-monitor",
  "deliveryId": "alert-123"
}
```

| Field         | Type     | Description                                                                                                                                              |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | string   | Message title (falls back to "Custom message")                                                                                                           |
| `description` | string   | Optional message body                                                                                                                                    |
| `color`       | string   | Optional embed color: a word (`red`, `green`, `yellow`, `blue`, `purple`, `orange`, `cyan`, `gray`) or `#rrggbb`                                         |
| `url`         | string   | Optional link for the title                                                                                                                              |
| `repo`        | string   | Optional `owner/repo`; prefixes the title and is used as the footer                                                                                      |
| `author`      | object   | Optional `{ name, iconUrl, url }`                                                                                                                        |
| `fields`      | object[] | Optional embed fields `{ name, value, inline }`                                                                                                          |
| `footer`      | string   | Optional footer override                                                                                                                                 |
| `deliveryId`  | string   | Optional id for sender-side dedup (retries). Without a `deliveryId` the nonce identifies the request; with neither, a retried request is delivered again |

## GitHub App Tenant Isolation

When the GitHub App is installed, its events arrive at the global endpoint for **every** installation. To keep tenants apart, bind each group to the installation id that should feed it: `"installationId": 12345678`. The id is visible in the App's installation webhook payload (`installation.id`) or on the GitHub App installation page URL. Events from any other installation are rejected for that group even if its `owners` list is empty. Groups without `installationId` keep the legacy behavior (`owners` filtering).

Binding is **auto-configured** — the GitHub App's _Setup URL_ should point to `{BASE_URL}/auth/github/install`. Right after a user installs the App, the browser lands there (the page requires a signed-in admin session — not signed in users are redirected through the OAuth flow first) and they choose where the installation binds: a **new group** (`inst-{installationId}`, default) or any **existing group they own** (owner role checked again on submit; `POST /auth/github/install/bind` performs the provisioning). No manual id entry is needed.

The `installation_id` in the Setup URL can be set to anything, so both the page and the bind step first verify — with the signed-in user's own GitHub token — that the user may manage that installation: they are the installation's own account, or an active **admin** of its organization (merely having access to it as a collaborator is not enough). Otherwise they are sent back with `?error=install-forbidden`. Super admins may bind any installation. With `ALLOW_SELF_SIGNUP`, the installer becomes owner of the dedicated `inst-{installationId}` group only while it is bound to that installation and has no members yet — no other group is ever handed to a new owner this way. Ids starting with `inst-` or `u-` are reserved for these system groups: only super admins may create or rename groups to them, and an existing unbound `inst-*` group is never bound automatically.

As a fallback (e.g. when the Setup URL is not configured), the `installation.created` webhook event — on the global endpoint only — creates/binds the group automatically: existing groups whose `owners` match the installing account are bound, otherwise a dedicated `inst-{installationId}` group is created. Then just add routes/members in the console. The provisioning runs after the delivery's dedup check and is recorded per installation and per bound group for 7 days, so a redelivered event never re-binds a group a super admin has unbound since; if provisioning fails, the endpoint answers `503` so the event is redelivered.

To show the installing account's login on the choice page, set `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY` — see [Secrets](./configuration#secrets).
