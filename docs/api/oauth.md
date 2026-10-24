# OAuth

WebHooker implements GitHub OAuth2 to enable user-initiated actions (comment, merge, react).

## Flow

```text
User → GET /auth/github → Redirect to GitHub → Authorize →
  → GET /auth/github/callback → Exchange code for token → Store in KV
```

## Endpoints

### Start OAuth

```
GET /auth/github
```

Redirects the user to GitHub's authorization page.

**Query Parameters:**

| Parameter  | Description                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect` | Optional relative path to return to after sign-in (e.g. `/admin`). Must start with `/` but not `//`; any unsafe value falls back to `/`. |

**Response:** `302` redirect to GitHub OAuth authorize URL.

### OAuth Callback

```
GET /auth/github/callback
```

GitHub redirects here after authorization. Exchanges the code for an access token and stores it in KV.

**Query Parameters (from GitHub):**

| Parameter | Description                         |
| --------- | ----------------------------------- |
| `code`    | Authorization code                  |
| `state`   | State parameter for CSRF protection |

A sign-in started in the browser (`GET /auth/github`) must come back with the `wh_oauth_state` cookie that start set; otherwise the callback answers `400 Invalid or expired state`.

**Response:**

- **Browser flow** (`Accept: text/html`): sets an admin session cookie, then redirects to the `redirect` target. Users without admin access are redirected to `/admin?error=forbidden`.
- **JSON flow**: returns `{ "userId": "...", "login": "...", "redirectTo": "..." }`.
- **Bot account link** (started by `/gh login` on Discord, Telegram or Feishu): nothing is linked yet. The callback answers with an HTML confirmation page that names both the GitHub account and the chat account; the link is written only when the GitHub user confirms it there.

### Confirm Bot Account Link

```
POST /auth/github/link
```

Submitted by the confirmation page (form field `nonce`, valid for 10 minutes and usable once). Links the chat account to the GitHub account and answers with an HTML result page; an unknown, expired or already used `nonce` gets `400` ("link expired").

### Revoke Token

```
DELETE /auth/token/:userId
```

Removes the stored OAuth token for a user (your own, or any user's for a super admin). The revocation is recorded in D1, so the token stops working everywhere at once, even where KV has not caught up yet.

**Response:**

```json
{
  "ok": true
}
```

## Token Storage

Tokens are stored in KV with key pattern `token:{userId}`:

```json
{
  "userId": "12345",
  "accessToken": "gho_...",
  "expiresAt": 1735689600000,
  "live": true
}
```

`expiresAt` is a Unix timestamp in milliseconds. A stored token is used for 10 hours; the KV entry expires after 9 hours (90%). Tokens are not refreshed — after that, sign in (or run `/gh login`) again. `live` marks a token whose "current token" record is kept in D1: signing in again or signing out invalidates the previous token everywhere at once. A reverse index `token-reverse:{sha256 of token}` maps the access token back to its user id so Bearer-authenticated endpoints can resolve the caller. Discord users linked to a GitHub account are stored in the D1 `discord_links` table; Telegram users in the D1 `telegram_links` table.

## Using Tokens

After OAuth, include the access token in the `Authorization` header for action API calls:

```bash
curl -X POST https://your-worker/api/comment \
  -H "Authorization: Bearer gho_..." \
  -H "Content-Type: application/json" \
  -d '{"owner": "org", "repo": "repo", "issueNumber": 1, "body": "Hello!"}'
```
