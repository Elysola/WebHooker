# OAuth

WebHooker 实现 GitHub OAuth2 以支持用户发起的操作（评论、合并、反应）。

## 流程

```text
用户 → GET /auth/github → 重定向到 GitHub → 授权 →
  → GET /auth/github/callback → 交换 code 获取 Token → 存储到 KV
```

## 端点

### 启动 OAuth

```
GET /auth/github
```

将用户重定向到 GitHub 的授权页面。

**查询参数：**

| 参数       | 说明                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| `redirect` | 可选，登录后返回的相对路径（如 `/admin`）。必须以 `/` 开头但不能以 `//` 开头；任何不安全的值回退为 `/`。 |

**响应：** `302` 重定向到 GitHub OAuth 授权 URL。

### OAuth 回调

```
GET /auth/github/callback
```

GitHub 授权后重定向到此地址。将 code 交换为访问令牌并存储到 KV。

**查询参数（来自 GitHub）：**

| 参数    | 说明                |
| ------- | ------------------- |
| `code`  | 授权码              |
| `state` | CSRF 保护的状态参数 |

在浏览器中发起（`GET /auth/github`）的登录，回调时必须带回发起时设置的 `wh_oauth_state` Cookie，否则返回 `400 Invalid or expired state`。

**响应：**

- **浏览器流程**（`Accept: text/html`）：设置管理员会话 Cookie，然后重定向到 `redirect` 目标；无管理权限的用户被重定向到 `/admin?error=forbidden`。
- **JSON 流程**：返回 `{ "userId": "...", "login": "...", "redirectTo": "..." }`。
- **机器人账号绑定**（由 Discord、Telegram 或飞书的 `/gh login` 发起）：此时还不会绑定。回调返回一个同时列出 GitHub 账号与聊天账号的 HTML 确认页；只有 GitHub 用户在该页确认后才写入绑定。

### 确认机器人账号绑定

```
POST /auth/github/link
```

由确认页提交（表单字段 `nonce`，10 分钟内有效、只能使用一次）。把聊天账号绑定到 GitHub 账号并返回 HTML 结果页；未知、过期或已使用的 `nonce` 返回 `400`（"链接已失效"）。

### 撤销 Token

```
DELETE /auth/token/:userId
```

删除用户存储的 OAuth Token（本人的，或超级管理员删除任意用户的）。撤销会记录在 D1 中，即使 KV 尚未同步，Token 也会在所有节点立即失效。

**响应：**

```json
{
  "ok": true
}
```

## Token 存储

Token 以键模式 `token:{userId}` 存储在 KV 中：

```json
{
  "userId": "12345",
  "accessToken": "gho_...",
  "expiresAt": 1735689600000,
  "live": true
}
```

`expiresAt` 是毫秒级 Unix 时间戳。保存的 Token 可使用 10 小时，KV 条目在 9 小时（90%）后过期。Token 不会自动刷新——过期后需要重新登录（或重新执行 `/gh login`）。`live` 表示该 Token 在 D1 中有"当前令牌"记录：重新登录或退出登录会让之前的 Token 在所有节点立即失效。反向索引 `token-reverse:{sha256 of token}` 将访问令牌映射回用户 id，使 Bearer 鉴权的端点能解析调用者。与 GitHub 账号绑定的 Discord 用户存储在 D1 的 `discord_links` 表中；Telegram 用户存储在 D1 的 `telegram_links` 表中。

## 使用 Token

OAuth 完成后，在操作 API 调用的 `Authorization` 头中包含访问令牌：

```bash
curl -X POST https://your-worker/api/comment \
  -H "Authorization: Bearer gho_..." \
  -H "Content-Type: application/json" \
  -d '{"owner": "org", "repo": "repo", "issueNumber": 1, "body": "你好！"}'
```
