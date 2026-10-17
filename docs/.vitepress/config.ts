import { defineConfig } from "vitepress";

const github = "https://github.com/Elysola/WebHooker";

export default defineConfig({
  title: "WebHooker",
  description: "GitHub webhook to Discord dispatcher on Cloudflare Workers",
  base: "/",

  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }]],

  locales: {
    root: {
      label: "English",
      lang: "en",
      themeConfig: {
        nav: [
          { text: "Guide", link: "/guide/introduction" },
          { text: "API", link: "/api/overview" },
          { text: "Events", link: "/events/supported" },
          {
            text: "Links",
            items: [
              { text: "GitHub", link: github },
              { text: "Changelog", link: `${github}/releases` },
            ],
          },
        ],
        sidebar: {
          "/guide/": [
            {
              text: "Guide",
              items: [
                { text: "Introduction", link: "/guide/introduction" },
                { text: "Getting Started", link: "/guide/getting-started" },
                { text: "Configuration", link: "/guide/configuration" },
              ],
            },
            {
              text: "Core Concepts",
              items: [
                { text: "Routes & Targets", link: "/guide/routes" },
                { text: "Groups & Access Control", link: "/guide/groups" },
                { text: "Webhook Ingress & Tenancy", link: "/guide/ingress" },
                { text: "Storage Layout", link: "/guide/storage" },
              ],
            },
            {
              text: "Messaging",
              items: [
                { text: "Bot Commands", link: "/guide/commands" },
                { text: "Message Format", link: "/guide/message-format" },
                { text: "Message Language (i18n)", link: "/guide/i18n" },
                { text: "Filter Tutorial", link: "/guide/filters" },
              ],
            },
            {
              text: "Operations",
              items: [
                { text: "Logs", link: "/guide/logs" },
                { text: "Scheduled Tasks", link: "/guide/tasks" },
                { text: "Deployment", link: "/guide/deployment" },
                { text: "FAQ", link: "/guide/faq" },
              ],
            },
          ],
          "/api/": [
            {
              text: "API Reference",
              items: [
                { text: "Overview (Public)", link: "/api/overview" },
                { text: "Admin API", link: "/api/admin" },
                { text: "OAuth", link: "/api/oauth" },
                { text: "Actions", link: "/api/actions" },
              ],
            },
          ],
          "/events/": [
            {
              text: "Events",
              items: [{ text: "Supported Events", link: "/events/supported" }],
            },
          ],
          "/contributing": [
            {
              text: "Development",
              items: [{ text: "Contributing", link: "/contributing" }],
            },
          ],
        },
        footer: {
          message: "Released under the MIT License.",
          copyright: "Copyright 2026 Elysola",
        },
        editLink: {
          pattern: `${github}/edit/main/docs/:path`,
          text: "Edit this page on GitHub",
        },
      },
    },
    zh: {
      label: "简体中文",
      lang: "zh-CN",
      themeConfig: {
        nav: [
          { text: "指南", link: "/zh/guide/introduction" },
          { text: "API", link: "/zh/api/overview" },
          { text: "事件", link: "/zh/events/supported" },
          {
            text: "链接",
            items: [
              { text: "GitHub", link: github },
              { text: "更新日志", link: `${github}/releases` },
            ],
          },
        ],
        sidebar: {
          "/zh/guide/": [
            {
              text: "指南",
              items: [
                { text: "简介", link: "/zh/guide/introduction" },
                { text: "快速开始", link: "/zh/guide/getting-started" },
                { text: "配置", link: "/zh/guide/configuration" },
              ],
            },
            {
              text: "核心概念",
              items: [
                { text: "路由与目标", link: "/zh/guide/routes" },
                { text: "分组与访问控制", link: "/zh/guide/groups" },
                { text: "Webhook 接入与租户隔离", link: "/zh/guide/ingress" },
                { text: "存储布局", link: "/zh/guide/storage" },
              ],
            },
            {
              text: "消息",
              items: [
                { text: "机器人命令", link: "/zh/guide/commands" },
                { text: "消息格式", link: "/zh/guide/message-format" },
                { text: "消息语言 (i18n)", link: "/zh/guide/i18n" },
                { text: "过滤器教程", link: "/zh/guide/filters" },
              ],
            },
            {
              text: "运维",
              items: [
                { text: "日志", link: "/zh/guide/logs" },
                { text: "定时任务", link: "/zh/guide/tasks" },
                { text: "部署", link: "/zh/guide/deployment" },
                { text: "常见问题", link: "/zh/guide/faq" },
              ],
            },
          ],
          "/zh/api/": [
            {
              text: "API 参考",
              items: [
                { text: "概览（公共 API）", link: "/zh/api/overview" },
                { text: "Admin API", link: "/zh/api/admin" },
                { text: "OAuth", link: "/zh/api/oauth" },
                { text: "用户操作", link: "/zh/api/actions" },
              ],
            },
          ],
          "/zh/events/": [
            {
              text: "事件",
              items: [{ text: "支持的事件", link: "/zh/events/supported" }],
            },
          ],
          "/zh/contributing": [
            {
              text: "开发",
              items: [{ text: "贡献指南", link: "/zh/contributing" }],
            },
          ],
        },
        footer: {
          message: "基于 MIT 许可发布。",
          copyright: "Copyright 2026 Elysola",
        },
        editLink: {
          pattern: `${github}/edit/main/docs/:path`,
          text: "在 GitHub 上编辑此页面",
        },
      },
    },
  },

  themeConfig: {
    logo: "/logo.svg",
    socialLinks: [{ icon: "github", link: github }],
    search: { provider: "local" },
  },
});
