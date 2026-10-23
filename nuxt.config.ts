import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  modules: ["@elysola/ui/nuxt"],
  elysolaUI: {
    prefix: "Rc",
  },
  css: ["~/assets/css/main.css"],
  // Target: Cloudflare Workers (single _worker.js via the cloudflare_module preset).
  nitro: {
    preset: "cloudflare_module",
    errorHandler: "~~/server/error-handler",
    experimental: {
      tasks: true,
    },
    scheduledTasks: {
      "*/5 * * * *": ["discord-sync", "telegram-sync", "audit-prune", "storage-prune"],
    },
  },
  app: {
    head: {
      title: "WebHooker",
      link: [
        { rel: "icon", type: "image/svg+xml", href: "/logo.svg" },
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap",
        },
      ],
      script: [
        {
          innerHTML: `(function(){try{var t=localStorage.getItem("wh-theme");var d=t==="dark"||(!t&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d){document.documentElement.classList.add("dark");document.documentElement.setAttribute("data-theme","dark");}else if(t==="light"){document.documentElement.setAttribute("data-theme","light");}}catch(e){}})();`,
        },
      ],
    },
  },
  vite: {
    plugins: [tailwindcss()],
    // App components use reka-ui primitives directly, alongside the copy
    // @elysola/ui imports. Pre-bundling it up front keeps both on one
    // dev instance; otherwise a mid-session discovery splits them and dialogs
    // and popovers stop stacking (Escape / outside clicks reach the wrong layer).
    // `debug` and `extend` are CommonJS packages @elysola/ui's markdown stack
    // (micromark, unified) imports; served unbundled in dev they lack a default
    // export and the console fails to start.
    optimizeDeps: {
      include: ["reka-ui", "debug", "extend"],
    },
  },
  devtools: { enabled: false },
  runtimeConfig: {
    // Overridable via NUXT_PUBLIC_DOCS_URL / NUXT_PUBLIC_REPO_URL /
    // NUXT_PUBLIC_LEGAL_CONTACT.
    public: {
      docsUrl: "",
      repoUrl: "",
      legalContact: "",
    },
  },
  // The config console stays a client-side SPA (same behavior as the old
  // standalone admin app); home/legal pages render server-side.
  routeRules: {
    "/admin/**": { ssr: false },
  },
});
