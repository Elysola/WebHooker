<template>
  <main class="landing-shell">
    <section class="landing-hero">
      <RcBadge variant="brand" size="sm">Elysola</RcBadge>
      <div class="brand-lockup">
        <AppLogo :size="64" class="brand-logo" />
        <div>
          <p class="eyebrow">Event relay console</p>
          <h1>Web<span>Hooker</span></h1>
        </div>
      </div>
      <p class="hero-copy">
        {{
          lang === "zh"
            ? "把 GitHub webhook 可靠地带到你的协作空间，并在一个清晰的控制台中掌控每一条路由。"
            : "Bring GitHub webhook activity into your collaboration space, with every route under clear control."
        }}
      </p>
      <div class="hero-meta">
        <span><GitBranch :size="15" /> GitHub</span>
        <span class="meta-line" aria-hidden="true" />
        <span><Radio :size="15" /> Discord · Telegram · Feishu</span>
      </div>
    </section>

    <section class="landing-actions" :aria-label="t('导航', 'Navigation')">
      <RcCard
        v-for="(it, index) in items"
        :key="it.label"
        variant="outline"
        :hoverable="true"
        padding="none"
        class="landing-action"
      >
        <a
          :href="it.href"
          :target="it.external ? '_blank' : undefined"
          :rel="it.external ? 'noopener noreferrer' : undefined"
        >
          <span class="action-index">0{{ index + 1 }}</span>
          <component :is="it.icon" class="action-icon" :size="22" :stroke-width="1.8" />
          <span class="action-copy">
            <strong>{{ it.label }}</strong>
            <small>{{ it.desc }}</small>
          </span>
          <ArrowUpRight v-if="it.external" class="action-arrow" :size="19" />
          <ArrowRight v-else class="action-arrow" :size="19" />
        </a>
      </RcCard>
    </section>

    <footer class="landing-footer">
      <span>WebHooker <i /> GitHub event delivery</span>
      <div class="landing-footer-actions">
        <ThemeToggle show-label />
        <NuxtLink :to="`/?lang=${altLang}`">
          <Languages :size="15" /> {{ lang === "zh" ? "English" : "中文" }}
        </NuxtLink>
      </div>
    </footer>
  </main>
</template>

<script setup lang="ts">
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  FileCheck2,
  GitBranch,
  Github,
  Languages,
  LogIn,
  Radio,
  ShieldCheck,
} from "lucide-vue-next";

const DEFAULT_REPO = "https://github.com/Elysola/WebHooker";
const DEFAULT_DOCS = "https://webhooker.docs.elysola.org";

const route = useRoute();
const config = useRuntimeConfig();

const lang = computed(() => (route.query.lang === "en" ? "en" : "zh"));
const altLang = computed(() => (lang.value === "zh" ? "en" : "zh"));
const repo = computed(() => (config.public.repoUrl as string) || DEFAULT_REPO);
const docsBase = computed(() =>
  ((config.public.docsUrl as string) || DEFAULT_DOCS).replace(/\/+$/, ""),
);

const t = (zh: string, en: string): string => (lang.value === "zh" ? zh : en);

const items = computed(() => {
  const docs = lang.value === "zh" ? `${docsBase.value}/zh` : `${docsBase.value}/`;
  const q = (p: string): string => `${p}?lang=${lang.value}`;
  return [
    {
      href: docs,
      label: t("文档", "Documentation"),
      desc: t("部署、配置与事件参考", "Deployment, configuration & event reference"),
      icon: BookOpen,
      external: true,
    },
    {
      href: repo.value,
      label: t("GitHub 仓库", "GitHub Repository"),
      desc: t("源代码、问题与发布", "Source code, issues & releases"),
      icon: Github,
      external: true,
    },
    {
      href: q("/terms"),
      label: t("服务条款", "Terms of Service"),
      desc: t("使用本服务的条款", "The terms for using this service"),
      icon: FileCheck2,
      external: false,
    },
    {
      href: q("/privacy"),
      label: t("隐私政策", "Privacy Policy"),
      desc: t("我们如何处理你的数据", "How we handle your data"),
      icon: ShieldCheck,
      external: false,
    },
    {
      href: "/admin",
      label: t("登录控制台", "Sign in to Console"),
      desc: t("管理路由与分组", "Manage routes and groups"),
      icon: LogIn,
      external: false,
    },
  ];
});

useHead({
  title: "WebHooker",
  meta: [
    {
      name: "description",
      content:
        lang.value === "zh"
          ? "GitHub webhook 转发到 Discord"
          : "GitHub webhooks forwarded to Discord",
    },
  ],
});
</script>

<style scoped>
.landing-shell {
  position: relative;
  z-index: 1;
  width: min(100% - 2rem, 880px);
  min-height: 100vh;
  margin: 0 auto;
  padding: clamp(4rem, 10vh, 8rem) 0 2rem;
  overflow-x: clip;
}
.landing-shell::before {
  position: absolute;
  z-index: -1;
  top: 3rem;
  right: -7rem;
  width: 24rem;
  height: 24rem;
  border-radius: 999px;
  background: radial-gradient(
    circle,
    color-mix(in srgb, rgb(var(--wh-accent)) 18%, transparent),
    transparent 68%
  );
  content: "";
  filter: blur(10px);
}
.landing-hero {
  max-width: 640px;
  animation: intro 500ms ease-out both;
}
.brand-lockup {
  display: flex;
  align-items: center;
  gap: 1.1rem;
  margin: 1.5rem 0;
}
.brand-logo {
  box-shadow: 0 16px 38px rgb(var(--wh-accent) / 0.28);
}
.eyebrow {
  margin: 0 0 0.25rem;
  color: rgb(var(--wh-accent));
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.15em;
  text-transform: uppercase;
}
h1 {
  margin: 0;
  font-size: clamp(2.55rem, 7vw, 4.6rem);
  font-weight: 800;
  letter-spacing: -0.07em;
  line-height: 0.88;
}
h1 span {
  color: rgb(var(--wh-accent));
}
.hero-copy {
  margin: 1.75rem 0 1.2rem;
  color: rgb(var(--wh-muted));
  font-size: clamp(1rem, 2vw, 1.15rem);
  line-height: 1.8;
}
.hero-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: rgb(var(--wh-faint));
  font-size: 0.77rem;
  font-weight: 700;
  letter-spacing: 0.025em;
}
.hero-meta span:not(.meta-line) {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.meta-line {
  width: 1.5rem;
  height: 1px;
  background: rgb(var(--wh-border-strong));
}
.landing-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.85rem;
  margin-top: clamp(2.5rem, 6vh, 4.5rem);
}
.landing-action {
  overflow: hidden;
  animation: intro 500ms ease-out both;
}
.landing-action:nth-child(2) {
  animation-delay: 60ms;
}
.landing-action:nth-child(3) {
  animation-delay: 120ms;
}
.landing-action:nth-child(4) {
  animation-delay: 180ms;
}
.landing-action:nth-child(5) {
  animation-delay: 240ms;
}
.landing-action a {
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  align-items: center;
  gap: 0.85rem;
  min-height: 6.7rem;
  padding: 1.15rem;
  color: inherit;
  text-decoration: none;
}
.action-index {
  align-self: start;
  color: rgb(var(--wh-faint));
  font-family: var(--font-mono);
  font-size: 0.63rem;
}
.action-icon {
  color: rgb(var(--wh-accent));
}
.action-copy {
  display: grid;
  gap: 0.22rem;
  min-width: 0;
}
.action-copy strong {
  font-size: 0.95rem;
}
.action-copy small {
  color: rgb(var(--wh-muted));
  font-size: 0.77rem;
  line-height: 1.4;
}
.action-arrow {
  color: rgb(var(--wh-faint));
  transition: transform 150ms ease;
}
.landing-action:hover .action-arrow {
  color: rgb(var(--wh-accent));
  transform: translate(2px, -2px);
}
.landing-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin-top: 2rem;
  color: rgb(var(--wh-faint));
  font-size: 0.75rem;
}
.landing-footer span {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}
.landing-footer i {
  width: 0.22rem;
  height: 0.22rem;
  border-radius: 999px;
  background: rgb(var(--wh-accent));
}
.landing-footer-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.landing-footer a {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: rgb(var(--wh-muted));
  text-decoration: none;
}
.landing-footer a:hover {
  color: rgb(var(--wh-accent));
}
@keyframes intro {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (max-width: 580px) {
  .landing-shell {
    width: min(100% - 1.5rem, 880px);
    padding-top: 3rem;
  }
  .landing-actions {
    grid-template-columns: 1fr;
  }
  .landing-footer {
    align-items: flex-start;
    flex-direction: column;
  }
  .hero-meta {
    align-items: flex-start;
    flex-direction: column;
  }
  .meta-line {
    display: none;
  }
}
</style>
