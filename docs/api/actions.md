# Actions

User action endpoints allow commenting on issues, merging/closing PRs, and adding reactions. All action endpoints require a valid Bearer token from the OAuth flow.

## Authentication

All action endpoints require the `Authorization` header:

```
Authorization: Bearer <github-access-token>
```

If the token is missing or invalid, the endpoint returns `401`.

## Endpoints

### Comment on Issue

```
POST /api/comment
```

Creates a comment on an issue or pull request.

**Request Body:**

```json
{
  "owner": "org",
  "repo": "repo",
  "issueNumber": 42,
  "body": "Comment text here"
}
```

| Field         | Type   | Required | Description                       |
| ------------- | ------ | -------- | --------------------------------- |
| `owner`       | string | Yes      | Repository owner                  |
| `repo`        | string | Yes      | Repository name                   |
| `issueNumber` | number | Yes      | Issue or PR number                |
| `body`        | string | Yes      | Comment body (Markdown supported) |

**Response:** `200 { "ok": true }`.

### Merge Pull Request

```
POST /api/merge
```

Merges a pull request.

**Request Body:**

```json
{
  "owner": "org",
  "repo": "repo",
  "pullNumber": 42,
  "method": "squash"
}
```

| Field        | Type   | Required | Description                                        |
| ------------ | ------ | -------- | -------------------------------------------------- |
| `owner`      | string | Yes      | Repository owner                                   |
| `repo`       | string | Yes      | Repository name                                    |
| `pullNumber` | number | Yes      | Pull request number                                |
| `method`     | string | No       | `merge`, `squash`, or `rebase` (default: `squash`) |

**Response:** `200 { "ok": true }`.

### Close Pull Request

```
POST /api/close
```

Closes a pull request without merging.

**Request Body:**

```json
{
  "owner": "org",
  "repo": "repo",
  "pullNumber": 42
}
```

| Field        | Type   | Required | Description         |
| ------------ | ------ | -------- | ------------------- |
| `owner`      | string | Yes      | Repository owner    |
| `repo`       | string | Yes      | Repository name     |
| `pullNumber` | number | Yes      | Pull request number |

**Response:** `200 { "ok": true }`.

### Add Reaction

```
POST /api/react
```

Adds an emoji reaction to an issue or pull request (not to a comment).

**Request Body:**

```json
{
  "owner": "org",
  "repo": "repo",
  "issueNumber": 42,
  "reaction": "rocket"
}
```

| Field         | Type   | Required | Description               |
| ------------- | ------ | -------- | ------------------------- |
| `owner`       | string | Yes      | Repository owner          |
| `repo`        | string | Yes      | Repository name           |
| `issueNumber` | number | Yes      | Issue or PR number        |
| `reaction`    | string | Yes      | Reaction type (see below) |

**Reaction Types:**

`+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket`, `eyes`

**Response:** `200 { "ok": true }`.

## Error Responses

| Status | Body                        | Cause                           |
| ------ | --------------------------- | ------------------------------- |
| `401`  | `{"error": "Unauthorized"}` | Missing or invalid Bearer token |
| `400`  | `{"error": "..."}`          | Invalid request body            |
| `500`  | `{"error": "..."}`          | GitHub API error                |
