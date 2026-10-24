# 机器人命令

[绑定你的 GitHub 账号](#绑定账号)后，即可在 Discord、Telegram 和飞书上**以本人身份**操作 GitHub——评论使用你自己的 OAuth token 发布，权限由 GitHub 强制校验。若 GitHub 拒绝操作（例如编辑他人的评论），机器人会明确告知。

## 绑定账号

使用任何命令前，需先绑定 GitHub 账号。授权有效期为 10 小时，过期后请重新执行 `/gh login`：

| 平台     | 命令                         | 效果                                                |
| -------- | ---------------------------- | --------------------------------------------------- |
| Discord  | `/gh login`                  | 返回一条仅你可见的 OAuth 链接，用于授权 GitHub 账号 |
| Discord  | `/gh logout`                 | 解除绑定                                            |
| Telegram | `/gh login`（仅限私聊）      | 返回 OAuth 链接                                     |
| Telegram | `/gh logout`（引用一条消息） | 解除绑定                                            |

链接保存在服务端（KV），并在 D1 中映射到你的 Discord/Telegram/飞书用户 ID。

在 GitHub 授权后，你会看到一个同时显示**双方**账号（你的 GitHub 登录名与发起链接的聊天账号）的确认页；确认之前不会绑定任何东西。若登录并非你本人发起（例如别人把他们的链接转发给你），直接关闭该页面即可。在 Telegram 与飞书中，`/gh login` 只在与机器人的私聊中响应，授权链接不会发到群里。

每个平台事件只执行一次命令：Telegram 重投的 update、飞书重试的事件或重放的 Discord 交互都不会重复评论、合并或关闭。在调用 GitHub 之前就失败的命令（例如存储错误）会交还给平台，在其重投时再次执行；一旦命令可能已到达 GitHub 就不会再重复——此时如果机器人回复失败，请先到 GitHub 确认，再决定是否重发命令。

## Discord

Discord 命令为**斜杠命令**与**消息右键菜单命令**，由定时任务同步（每 5 分钟）：按服务器即时注册（每轮最多 30 次 Discord API 调用，加入大量服务器的机器人会分几轮补齐），并全局注册（约 1 小时传播）。命令定义变化时两者都会重新注册，全局注册至少每天一次。所有回复均为临时消息（仅你可见）。

### 评论 issue / PR

两种等效方式：

- **右键通知**（推荐）：右键机器人发出的 issue / PR / 评论通知 → **应用** → **GitHub: 添加评论 / 编辑评论 / 删除评论**。目标自动从通知嵌入中提取，无需链接。
- **带链接的斜杠命令**：

  ```
  /gh comment add  link:<issue 或 PR 链接>    例如 https://github.com/owner/repo/issues/123
  /gh comment edit link:<评论链接>             链接需包含 #issuecomment-<id>
  /gh comment del  link:<评论链接>             链接需包含 #issuecomment-<id>
  ```

  `edit` / `del` 需要在 GitHub 上复制具体评论链接（评论 ⋯ 菜单 → **复制链接**）。`add` / `edit` 会打开模态框输入/调整评论内容（edit 会预填，上限为 Discord 的 4000 字；更长的评论需到 GitHub 上编辑，避免内容被截断）。如果模态框打开后该评论已在 GitHub 上被修改，保存编辑会被拒绝——请重新打开，以当前内容为基础修改。正文按输入原样提交（保留缩进与换行）。只接受 `https://github.com/...` 链接。

### 合并 / 关闭 PR

github.com 上开放 PR 的通知附带 **合并 / 关闭** 按钮（文案跟随分组的消息语言；Gitea 等其他平台不显示按钮，因为这些操作调用的是 GitHub API）：

- 点击按钮即以你绑定的 GitHub 账号合并（squash）或关闭 PR；权限由 GitHub 强制校验。
- 成功后按钮会从通知中移除，结果以临时消息展示。

### 前置条件

| 项目       | 如何满足                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------- |
| 公钥       | 设置 `DISCORD_PUBLIC_KEY` 并配置 Interactions Endpoint URL                                          |
| 邀请 scope | 机器人以 `applications.commands` scope 邀请（见 [Discord Bot 设置](./deployment#discord-bot-设置)） |
| OAuth      | 配置 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` 与 `BASE_URL`                                      |
| 绑定账号   | 每位用户先执行 `/gh login`                                                                          |

## Telegram

Telegram `/gh` 命令通过**引用一条通知消息**来使用：

- `/gh login` — 绑定 GitHub 账号（仅限与机器人私聊；返回 OAuth 链接）
- `/gh logout` — 解除绑定
- `/gh comment <文本>` — 引用 issue/PR 通知以本人身份评论
- `/gh merge` / `/gh close` — 引用 PR 通知进行合并/关闭

目标 issue/PR 从你引用的消息（通知嵌入中的链接）解析。群聊中也接受 `/gh@你的机器人 …` 的写法（发给其他机器人的命令会被忽略）。评论正文保留换行与缩进。命令通过 Telegram webhook（`POST /telegram/webhook`）送达，该端点始终校验 secret token——`TELEGRAM_WEBHOOK_SECRET`，未设置时使用由 `TELEGRAM_TOKEN` 派生的值。

## 飞书

飞书 `/gh` 命令是以 `/gh` 开头（可在前面 @ 机器人）的消息：`/gh login`（仅限私聊）、`/gh logout`、`/gh comment <PR/Issue 链接> <内容>`、`/gh merge <PR 链接>`、`/gh close <PR 链接>`；卡片上也有**合并** / **关闭**按钮。只是在其他位置提到 `/gh` 的消息不算命令。事件订阅见[飞书机器人配置](./deployment#飞书机器人配置)。
