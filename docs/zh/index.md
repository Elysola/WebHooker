---
layout: home

hero:
  name: WebHooker
  text: GitHub / Gitea Webhook → Discord
  tagline: 通过 Cloudflare Workers 接收 GitHub 与 Gitea 事件，应用过滤器，将格式化消息路由到 Discord 频道/子区与 Telegram 群组/话题。
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: alt
      text: 在 GitHub 上查看
      link: https://github.com/Elysola/WebHooker

features:
  - title: 28 种事件格式化器
    details: 为 push、pull_request、issues、release、workflow_run 及其他 23 种事件类型提供丰富的 Discord 嵌入与 Telegram HTML 消息，支持颜色编码输出。
  - title: 灵活的过滤器
    details: 支持按事件类型、仓库、参与者、操作、分支（含 PR）和关键字（支持正则）过滤。支持排除模式。
  - title: Cloudflare Workers
    details: 运行在 Cloudflare 边缘网络上。通过 Discord REST API 与 Telegram Bot API 发送消息，并通过 Ed25519 验签的 Interactions Endpoint 支持 `/gh` 斜杠命令与按钮。
  - title: Web UI、分组与命令
    details: "在内置管理控制台中管理路由、分组与发送日志。绑定你的 GitHub 账号，通过 /gh 命令以本人身份评论 issue/PR（Discord 或 Telegram）。"
  - title: 签名验证
    details: 按提供方识别进行 HMAC-SHA256 webhook 签名验证（GitHub X-Hub-Signature-256、Gitea X-Gitea-Signature）与 Ed25519 交互签名验证，使用 Web Crypto API 并支持时间安全比较。
  - title: 原地更新
    details: workflow_run / check_run 进度在运行推进时于同一条消息上原地更新，Discord 与 Telegram 均支持。
---
