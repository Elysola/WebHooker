# 过滤器教程

过滤器决定哪些 Webhook 事件会被[路由](./routes)转发。只有当路由 `filters` 数组中的**每一个**过滤器都匹配时，路由才会触发（AND 逻辑）。本页是一份上手教程：解释每种过滤器类型的行为，以及如何组合它们实现真实场景的路由规则。

参考表格见配置指南的[过滤器类型](./configuration#过滤器类型)，完整事件列表见[支持的事件](../events/supported)。

## 匹配机制

- 路由中所有过滤器都必须匹配，否则该路由被跳过。
- 每个过滤器将事件与 Webhook 载荷的某个字段进行匹配。
- 所有过滤器类型都**不区分大小写**。
- `match` 值可以是单个字符串，也可以是字符串数组。数组相当于 OR——只要其中一个值匹配，该过滤器即匹配。
- 设置 `"exclude": true` 会反转结果（NOT 逻辑）：当值**不**匹配时，该过滤器才匹配。

```json
{
  "type": "event",
  "match": ["push", "pull_request"],
  "exclude": false
}
```

上面这条路由同时匹配 `push` 和 `pull_request` 事件。

## 模式语法

所有过滤器类型共享以下三种模式写法：

| 模式           | 含义                                                            |
| -------------- | --------------------------------------------------------------- |
| `纯文本`       | 字段过滤器：**完全相等**匹配；`keyword`：在载荷中任意位置搜索。 |
| `*` / `?`      | **通配符（glob）**——`*` 任意长度、`?` 恰好一个字符。            |
| `/正则表达式/` | 按**正则表达式**编译（忽略大小写标志）。                        |

- 字段过滤器（`event`/`repo`/`actor`/`action`/`branch`）的纯文本与通配符匹配整个值；`keyword` 则在载荷中任意位置搜索。
- 正则表达式始终是搜索语义：`/^feat/` 匹配以 `feat` **开头**的值，`/feat/` 匹配任意位置出现 `feat` 的值。

示例：

```json
{ "type": "event", "match": "pull_*" }
```

匹配 `pull_request`、`pull_request_review`、`pull_request_review_comment` 等。

```json
{ "type": "repo", "match": "myorg/*" }
```

```json
{ "type": "branch", "match": "feature-?" }
```

匹配 `feature-x`、`feature-1`，但不匹配 `feature-xy`。

```json
{ "type": "branch", "match": "/^feat/" }
```

匹配任何以 `feat` 开头的分支名。

> [!TIP]
> 通配符和正则同样不区分大小写，且 `*` 可以跨过仓库名中的 `/`（`myorg/*` 也能匹配 `myorg/sub/backend`）。

## 各过滤器类型详解

### `event` — 事件类型

匹配 GitHub 事件名称，如 `push`、`pull_request`、`issues`、`release`。它是每条路由的主干。

```json
{ "type": "event", "match": "release" }
```

用数组匹配多种事件：

```json
{ "type": "event", "match": ["create", "delete"] }
```

### `repo` — 仓库

匹配仓库**全名**（`owner/name`）。不区分大小写。

```json
{ "type": "repo", "match": "myorg/backend" }
```

将多个仓库路由到同一频道：

```json
{ "type": "repo", "match": ["myorg/backend", "myorg/frontend"] }
```

### `actor` — 发送者

匹配触发事件的 **GitHub 发送者登录名**（载荷中的 `sender.login`）。常用于忽略机器人。

```json
{ "type": "actor", "match": "dependabot[bot]", "exclude": true }
```

上面这条路由对**除** Dependabot 触发之外的所有事件都会触发。

### `action` — 事件操作

匹配载荷中的 `action` 字段，如 `opened`、`closed`、`published`、`completed`。并非所有事件都带有 action——参见[过滤器兼容性](../events/supported#过滤器兼容性)。与 `event` 组合可精确到某个生命周期步骤：

```json
{
  "type": "event",
  "match": "pull_request",
  "exclude": false
},
{
  "type": "action",
  "match": ["opened", "reopened"]
}
```

上面的规则在拉取请求被打开或重新打开时触发（合并/关闭/编辑时不触发）。

### `branch` — 分支

匹配事件涉及的分支。何种字段算作「分支」取决于事件类型：

| 事件                        | 提取的分支                          |
| --------------------------- | ----------------------------------- |
| `push`                      | 推送到的目标分支                    |
| `pull_request`（及 review） | 拉取请求的 **head**（源）分支       |
| `create` / `delete`         | 创建/删除的分支或标签               |
| `workflow_run`              | 工作流运行所在的 `head_branch`      |
| `workflow_job`              | 作业运行所在的 `head_branch`        |
| `check_suite`               | 检查套件的 `head_branch`            |
| `deployment`                | 部署引用（去除 `refs/heads/` 前缀） |
| `code_scanning_alert`       | 告警所属的分支                      |

```json
{
  "type": "event",
  "match": "push"
},
{
  "type": "branch",
  "match": "main"
}
```

仅当推送到 `main` 时触发。要关注多个长期分支：

```json
{ "type": "branch", "match": ["main", "develop"] }
```

> [!NOTE]
> `branch` 匹配不区分大小写。需要前缀或通配符式匹配时，可直接使用通配符（`feature/*`）或用 `/` 包裹正则（`/^release-/`）。

### `keyword` — 载荷中的文本

匹配整个 JSON 载荷（转为小写）。它是最灵活的过滤器：纯文本在任意位置搜索，`*`/`?` 通配符带通配搜索，`//` 包裹的模式按正则表达式编译（带 `i` 标志）。

```json
{ "type": "keyword", "match": "deploy" }
```

当载荷中任意位置包含 `deploy` 时触发。由于载荷已被转为小写，`Deploy`、`DEPLOY` 等都会匹配。

```json
{ "type": "keyword", "match": "*release-*" }
```

```json
{ "type": "keyword", "match": "/^(fix|hotfix)/" }
```

```json
{ "type": "keyword", "match": "/release-[0-9]+/" }
```

行为细节：

- 超过 200 个字符的模式**不**编译为通配符/正则，回退为纯文本匹配。
- 被 `/` 包裹但**不是合法正则**的模式匹配**任何内容都不命中**（过滤器恒为 false），而不会报错。
- 要搜索是通配符或正则特殊字符的文本（如 `v1.2.3`），使用纯文本形式即可——不含 `*`、`?` 且未被 `//` 包裹的模式按字面匹配。
- 搜索覆盖**整个**载荷：提交信息、PR 标题与正文、标签、引用，甚至仓库名和发送者名。

### `keyword` 与 `exclude` 组合

与其他过滤器一样，`exclude` 会反转关键词匹配：

```json
{ "type": "keyword", "match": "/wip|draft/", "exclude": true }
```

跳过载荷中提及 `wip` 或 `draft` 的事件。

### `field` — 任意载荷字段（JSONPath）

使用点号分隔的路径匹配载荷的任意字段，例如 `pull_request.user.login`、`repository.private` 或 `check_run.conclusion`。数组字段会自动展开——只要**任意一个**元素匹配，过滤器即匹配。

```json
{ "type": "field", "path": "pull_request.user.login", "match": "dependabot[bot]" }
```

```json
{ "type": "field", "path": "labels.name", "match": "bug" }
```

### 操作符

字段过滤器（以及除 `keyword` 之外的所有过滤器类型）可通过 `op` 改变值的比较方式。默认的 `eq` 保持经典的 glob/正则/精确匹配行为。

| 操作符       | 含义                                     |
| ------------ | ---------------------------------------- |
| `eq`（默认） | 相等——通配符、正则与纯文本，不区分大小写 |
| `ne`         | 不相等（`eq` 的反义）                    |
| `contains`   | 值包含模式（子串）                       |
| `startsWith` | 值以模式开头                             |
| `endsWith`   | 值以模式结尾                             |
| `regex`      | 显式正则表达式匹配                       |
| `gt` / `gte` | 数值大于 / 大于等于                      |
| `lt` / `lte` | 数值小于 / 小于等于                      |
| `in`         | 值等于任一列出的模式                     |
| `exists`     | 字段存在（非 null）；忽略 `match`        |

```json
{ "type": "field", "path": "pull_request.commits", "op": "gt", "match": "1" }
```

```json
{ "type": "field", "path": "label.name", "op": "startsWith", "match": "area/" }
```

### 分组（all / any / not）

路由可以使用嵌套的 `ast` 以显式分组组合过滤器，而不是扁平的 AND 列表。`ast` 节点是 `{ "all": [...] }`、`{ "any": [...] }` 或 `{ "not": {...} }` 之一：

```json
{
  "id": "grouped",
  "name": "Grouped",
  "ast": {
    "all": [
      { "type": "event", "match": "pull_request" },
      {
        "any": [
          { "type": "field", "path": "pull_request.user.login", "match": "alice" },
          { "type": "field", "path": "pull_request.user.login", "match": "bob" }
        ]
      }
    ]
  },
  "targets": [{ "channelId": "..." }]
}
```

当 `ast` 存在时，它优先于 `filters`。管理后台的路由编辑器会以可视化方式构建 `ast`（all/any/not 分组）、实时展示树状解释，并可通过「测试匹配」面板粘贴 JSON 载荷进行试匹配。

匹配值、字段路径与测试事件均为可搜索的下拉框。候选项来自 GitHub 与 Gitea 的 webhook 定义——事件、路由所选事件的动作、常用载荷路径及其已知取值——以英文 key 展示，并附当前界面语言的说明；搜索优先匹配 key，其次匹配英文或中文说明。列表之外的值仍可直接输入，添加前会按匹配规则校验，只拒绝永远不可能匹配的值（含空格的事件名、含 git 禁用字符的分支、无效的正则、比较运算中的非数字等）；仓库与操作者不做格式限制，因为自定义 webhook 可以携带任意字符串。已输入但未按<kbd>回车</kbd>添加的内容会阻止保存路由、存为片段和测试匹配，而不会被静默添加或丢弃。可一次输入或粘贴多个值，以逗号或换行分隔；`/正则/` 内的逗号会保留，选择「正则匹配」运算符时只按换行分隔（如 `^v{1,3}` 这样的原始模式可以包含逗号）。`field` 路径中途的数组会被展开，但以数组**结尾**的路径（如 `commits.modified`）会作为整体比较——要匹配其中某个元素请用「包含」；在编辑器中选择这类候选路径时会自动切换为「包含」。

### 命名过滤器片段

路由编辑器可将当前过滤器树保存为**命名片段**并插入其他路由。片段是编辑器侧的模板，存储在 D1（`d1_fragments`）中；插入片段会将其节点内联进路由的 `ast`，因此匹配引擎本身从不解析片段引用。

## 示例 1：PR 通知，跳过机器人和草稿

转发拉取请求动态，但忽略机器人作者和草稿 PR，发往 `#prs` 频道：

```json
{
  "id": "pr-notices",
  "name": "PR Notices",
  "enabled": true,
  "groupId": "eng",
  "filters": [
    { "type": "event", "match": "pull_request" },
    { "type": "actor", "match": "dependabot[bot]", "exclude": true },
    { "type": "keyword", "match": "\"draft\": true", "exclude": true }
  ],
  "target": { "channelId": "111111111111111111" }
}
```

`"draft": true` 模式匹配 GitHub 在拉取请求载荷中包含的 `draft` 字段；配合 `exclude: true` 即可过滤掉草稿 PR。

## 示例 2：仅发布通知频道

只转发特定仓库的已发布 release：

```json
{
  "id": "release-alerts",
  "name": "Release Alerts",
  "enabled": true,
  "groupId": "eng",
  "filters": [
    { "type": "event", "match": "release" },
    { "type": "action", "match": "published" },
    { "type": "repo", "match": "myorg/backend" }
  ],
  "target": { "channelId": "222222222222222222" }
}
```

## 示例 3：CI 失败

转发任意分支上以失败结束的 workflow run，发往 `#ci` 频道：

```json
{
  "id": "ci-failures",
  "name": "CI Failures",
  "enabled": true,
  "groupId": "eng",
  "filters": [
    { "type": "event", "match": "workflow_run" },
    { "type": "action", "match": "completed" },
    { "type": "keyword", "match": "\"conclusion\":\"failure\"" }
  ],
  "target": { "channelId": "333333333333333333" }
}
```

## 常见陷阱

- **通配符是 glob，不是正则。** `repo: "myorg/*"` 匹配 `myorg` 下的任意仓库（含 `myorg/sub/backend`），但 `repo: "myorg/.*"` 按字面匹配。需要正则请用 `/` 包裹：`"/myorg\/.*/"`。
- **被 `/` 包裹的非法正则永远不匹配。** 与纯文本不同——未包裹的非法模式按字面匹配。只有确定是真正的正则时才使用 `//` 包裹。
- **`action` 过滤器遇到无 action 的事件永远不匹配。** 先确认该事件带有 `action` 字段（见[过滤器兼容性](../events/supported#过滤器兼容性)）。
- **`branch` 过滤器遇到无分支的事件永远不匹配。** 在 `issues` 事件上使用 `branch` 过滤器恒为假。此时需要类似分支的匹配可用 `keyword`。
- **`keyword` 会搜索一切。** 因为它扫描整个载荷，`"fix"` 这样的模式可能同时匹配提交信息、issue 标题和仓库名。请尽量写得更具体。
- **牢记 `exclude` 语义。** `exclude: true` 反转的是整个过滤器——数组中的一个值不匹配并不会「阻断」路由；只有当**所有**值都不匹配时，取反后的过滤器才匹配。
