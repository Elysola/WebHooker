# 常见问题与故障排查

## 为什么 Discord 机器人显示为离线？

机器人从不连接 Discord Gateway——它始终通过 REST API 发送消息，并通过 HTTPS Interactions Endpoint 接收交互。**离线是正常现象**，不影响消息投递。

## 我的 webhook 没有被转发

按顺序检查：

1. `GET /health` 返回 `{"status":"ok"}`。
2. webhook URL 指向 `{BASE_URL}/webhook`，且密钥与 `GITHUB_WEBHOOK_SECRET` / `GITEA_WEBHOOK_SECRET` 一致。
3. 存在至少一条**启用**且匹配该事件（`event` 过滤器）的路由，且其分组允许该发送者（见分组的 `owners` / `providers` / `installationId`）。
4. 路由至少有一个目标，且频道/群组 id 有效。
5. 查看控制台**日志**标签页——每次分发尝试都会记录错误。

## Discord 机器人不响应命令/按钮

- 必须设置 `DISCORD_PUBLIC_KEY`，且 **Interactions Endpoint URL** 指向 `{BASE_URL}/discord/interactions`。
- 用户需先执行 `/gh login`，且 OAuth 密钥（`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`、`BASE_URL`）已配置。
- 斜杠命令由定时任务每 5 分钟同步；全局注册可能需要约 1 小时传播。

## 创建标签/分支后收到"0 个提交"的推送消息

通过 `git push` 创建标签或空分支时，事件以 `created: true` 且无提交的 push 事件到达——由于载荷带有 `created` 标志，会被渲染为正常的创建消息。若仍看到"0 个提交"，说明载荷中缺少 `created` 标志（例如旧或不合规的投递）。

## 删除分支后收到"0 个提交"的推送消息

通过 `git push --delete` 删除分支时，事件以 `deleted: true` 的 push 事件到达——会被渲染为正常的删除消息。若仍看到"0 个提交"，说明载荷中缺少 `deleted` 标志（例如旧投递）。

## 如何让分组使用自己的 webhook 端点？

见[分组端点](./ingress#分组端点-post-webhook-groupid)——在分组的 **Webhook 端点**面板（owner 角色）生成密钥，然后用 `POST /webhook/{groupId}` 与分组密钥发送。

## 可以脱离 Cloudflare Workers 运行吗？

不能——Worker 依赖 `wrangler.jsonc` 中声明的 KV 与 D1 绑定，并运行在 `cloudflare_module` Nitro preset 上。

## 数据存储在哪里？

配置存于 D1（`d1_routes`/`d1_groups`，在内存中最多缓存 60 秒）；webhook 去重、投递状态与消息更新追踪同样存于 D1（KV 回退）；发送/审计日志与平台↔GitHub 绑定存于 D1；超大负载可选存于 R2。见[存储布局](./storage#存储决策)。
