# 用户操作

用户操作端点支持评论议题、合并 PR 和添加反应。所有操作端点都需要来自 OAuth 流程的有效 Bearer Token。

## 鉴权

所有操作端点都需要 `Authorization` 头：

```
Authorization: Bearer <github-access-token>
```

如果 Token 缺失或无效，端点返回 `401`。

## 端点

### 评论议题

```
POST /api/comment
```

在议题或拉取请求上创建评论。

**请求体：**

```json
{
  "owner": "org",
  "repo": "repo",
  "issueNumber": 42,
  "body": "评论内容"
}
```

| 字段          | 类型   | 必需 | 说明                      |
| ------------- | ------ | ---- | ------------------------- |
| `owner`       | string | 是   | 仓库所有者                |
| `repo`        | string | 是   | 仓库名称                  |
| `issueNumber` | number | 是   | 议题或 PR 编号            |
| `body`        | string | 是   | 评论内容（支持 Markdown） |

**响应：** `200 { "ok": true }`。

### 合并拉取请求

```
POST /api/merge
```

合并拉取请求。

**请求体：**

```json
{
  "owner": "org",
  "repo": "repo",
  "pullNumber": 42,
  "method": "squash"
}
```

| 字段         | 类型   | 必需 | 说明                                            |
| ------------ | ------ | ---- | ----------------------------------------------- |
| `owner`      | string | 是   | 仓库所有者                                      |
| `repo`       | string | 是   | 仓库名称                                        |
| `pullNumber` | number | 是   | 拉取请求编号                                    |
| `method`     | string | 否   | `merge`、`squash` 或 `rebase`（默认：`squash`） |

**响应：** `200 { "ok": true }`。

### 关闭拉取请求

```
POST /api/close
```

不合并、直接关闭拉取请求。

**请求体：**

```json
{
  "owner": "org",
  "repo": "repo",
  "pullNumber": 42
}
```

| 字段         | 类型   | 必需 | 说明         |
| ------------ | ------ | ---- | ------------ |
| `owner`      | string | 是   | 仓库所有者   |
| `repo`       | string | 是   | 仓库名称     |
| `pullNumber` | number | 是   | 拉取请求编号 |

**响应：** `200 { "ok": true }`。

### 添加反应

```
POST /api/react
```

为议题或拉取请求添加表情反应（不支持评论）。

**请求体：**

```json
{
  "owner": "org",
  "repo": "repo",
  "issueNumber": 42,
  "reaction": "rocket"
}
```

| 字段          | 类型   | 必需 | 说明               |
| ------------- | ------ | ---- | ------------------ |
| `owner`       | string | 是   | 仓库所有者         |
| `repo`        | string | 是   | 仓库名称           |
| `issueNumber` | number | 是   | 议题或 PR 编号     |
| `reaction`    | string | 是   | 反应类型（见下方） |

**反应类型：**

`+1`、`-1`、`laugh`、`confused`、`heart`、`hooray`、`rocket`、`eyes`

**响应：** `200 { "ok": true }`。

## 错误响应

| 状态码 | 响应体                      | 原因                      |
| ------ | --------------------------- | ------------------------- |
| `401`  | `{"error": "Unauthorized"}` | 缺少或无效的 Bearer Token |
| `400`  | `{"error": "..."}`          | 无效的请求体              |
| `500`  | `{"error": "..."}`          | GitHub API 错误           |
