# 消息格式

每个事件格式化器都会产出一条平台中立的消息（`NeutralMessage`），由平台驱动渲染为 Discord 嵌入或 Telegram HTML 消息。

## 标题

每个标题必须以仓库名开头，随后是可选的 `#number`，再是 `: 描述`：

```
{repo}{#number}: {subject}      例如 acme/widget#7: Add feature
```

仓库名取自 `payload.repository.full_name`（缺失时回退为通用的「repository」标签）。评论、审查与行内评论使用与其父对象相同的 `{repo}{#number}: {title}` 标题——绝不使用 `"Comment on org/repo"` 前缀。

## 链接

只有仓库头会被加超链接——整条标题永远不会整体链接：

- **Discord**（嵌入标题不支持局部链接）：标题为仓库头 `{repo}{#number}`，链接到事件对象（issue、PR、评论或运行页面）；`: {subject}` 文本作为描述首行渲染，不带链接。
- **Telegram**（HTML 支持行内链接）：单行标题保留描述文本，仅仓库头被包在链接中。

标题中不含冒号分隔符（`:` 后跟一个空格）的消息保持旧的整行链接行为。

提交哈希、分支与标签渲染为带超链接的行内代码（如 ``[`abc123d`](https://…/commit/abc123def456)``），仓库基地址不可用时回退为纯行内代码。

创建或删除分支、标签的消息会将仓库标题链接到对应的分支或标签页面。

对于 push 事件，若提交作者的 GitHub 用户名与推送者不同，提交行末尾会附上作者链接（如 `- [octocat](https://github.com/octocat)`）。GitHub 无法解析机器人账户并返回 `invalid-email-address` 时，会显示提交中的作者名称而不添加链接。

## 表情

事件专属表情由格式化器添加；分组级 `Group.emoji`（默认开启）关闭后会全部去除。里程碑进度条不受影响。见[消息语言](./i18n)。

## 来源平台标识

设置 `Group.forgeSources`（一组 `{ host, type, name? }` 条目）后，消息底部会标注匹配的来源——即 `type`（`github` / `gitea`）与事件来源一致、且 `host` 与仓库 URL 主机名一致的第一条配置，标识文本为其可选 `name`（未填回退为 host）——便于区分来自不同 forge 的事件。见[分组 → 来源平台标识](./groups#来源平台标识)。

## 原地更新

会随时间变化的对象只发送一条消息，之后原地编辑：`workflow_run` 与 `check_run` / `check_suite` 随运行进度（queued → running → success/failure），部署及其状态，以及 issue 评论、PR 审核与审核评论在编辑或删除时，都不会另发新消息。每次编辑都按最新事件重新渲染整条消息。追踪使用 D1 `message_tracking`（KV `msg:*` 为回退）与每个对象的稳定 `updateKey`：`workflow_run` 以 run id 为键，`check_suite` 以 suite id 为键，`check_run` 则以检查套件（或 App）+ check 名 + commit SHA 为键（回退到 run id），因此每个阶段都换新 run id 的部署（例如 Cloudflare Pages）仍会编辑同一条消息。消息链还按来源（provider + 仓库主机）和目标平台区分，两个拥有相同 `owner/repo` 的 Gitea 实例不会互相编辑对方的消息。比消息当前所示状态更旧的事件（迟到）不会覆盖它；编辑失败会记为失败而不是再发一条——只有旧消息已不存在时才发送新消息。

## Workflow 作业

`workflow_run` 消息包含一个 **Jobs** 字段，以带颜色的 diff 代码块列出该次运行的全部作业（Discord）：

```
+ build ✅ success · 1m 23s
  deploy 🔄 running
  lint ⏳ queued
- test ❌ failure · 0m 45s
```

每行格式为 `{作业名} {emoji}{状态}`，作业完成后追加耗时。成功的作业以 `+` 前缀（绿色），失败/其他已结束的作业以 `-` 前缀（红色），运行中/排队中/待定的作业使用普通空格（无颜色）。作业名截断至 200 字符，整个字段截断至平台字段上限。不支持 diff 的驱动（Telegram、飞书）会把该代码块渲染为单个行内代码片段。

`workflow_run` 的 webhook 载荷本身不含作业列表，只有 `jobs_url`。Worker 会从该 URL 拉取作业（每次投递一次 GitHub API 调用，没有路由命中时跳过）：配置了 `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` 时用 GitHub App 安装令牌鉴权，否则匿名请求（仅公开仓库）。因此 App 需要 **Actions: read** 仓库权限。若拉取失败（缺少权限、私有仓库且未配置 App 凭据、触发限流），消息直接省略 Jobs 字段。
