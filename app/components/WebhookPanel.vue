<template>
  <RcCard variant="outline" padding="md" class="members-panel webhook-panel">
    <div class="panel-head">
      <h3>{{ t("webhook.title") }}</h3>
      <span class="lbl-note">{{ t("webhook.note") }}</span>
    </div>

    <p v-if="!info" class="empty-log">{{ t("webhook.empty") }}</p>

    <template v-else>
      <div class="wh-row">
        <span class="wh-label">{{ t("webhook.url") }}</span>
        <code class="wh-value">{{ info.url }}</code>
        <RcButton type="button" variant="ghost" size="sm" @click="copy(info.url, 'url')">
          {{ copied === "url" ? t("webhook.copied") : t("webhook.copy") }}
        </RcButton>
      </div>

      <div class="wh-row">
        <span class="wh-label">{{ t("webhook.secret") }}</span>
        <code class="wh-value">{{
          info.secret ? info.secret : info.hasSecret ? maskedSecret : t("webhook.noSecret")
        }}</code>
        <RcButton
          v-if="info.secret"
          type="button"
          variant="ghost"
          size="sm"
          @click="copy(info.secret!, 'secret')"
        >
          {{ copied === "secret" ? t("webhook.copied") : t("webhook.copy") }}
        </RcButton>
      </div>
      <p v-if="info.hasSecret && !info.secret" class="hint">{{ t("webhook.secretHidden") }}</p>

      <div class="wh-actions">
        <RcButton type="button" size="sm" :disabled="busy" @click="onRegenerate">
          {{ info.hasSecret ? t("webhook.regenerate") : t("webhook.generate") }}
        </RcButton>
        <RcButton
          v-if="info.hasSecret"
          type="button"
          variant="ghost"
          color="error"
          size="sm"
          :disabled="busy"
          @click="onDisable"
        >
          {{ t("webhook.disable") }}
        </RcButton>
      </div>

      <details class="wh-usage">
        <summary>{{ t("webhook.usageTitle") }}</summary>
        <p class="hint">{{ t("webhook.usageGitHub") }}</p>
        <p class="hint">{{ t("webhook.usageGitea") }}</p>
        <p class="hint">{{ t("webhook.usageCustom") }}</p>
        <pre class="wh-code">{{ customExample }}</pre>
      </details>
    </template>

    <div class="err">{{ error }}</div>
  </RcCard>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useWebhookApi, type GroupWebhookInfo } from "~/composables/useWebhook";

const { t } = useI18n();
const { confirm } = useConfirm();

const props = defineProps<{ groupId: string; canEdit: boolean }>();

const api = useWebhookApi();
const info = ref<GroupWebhookInfo | null>(null);
const busy = ref(false);
const error = ref("");
const { copied, copy } = useCopy();

const maskedSecret = "••••••••••••••••";
const customExample = [
  'curl -X POST "$URL" \\',
  '  -H "Content-Type: application/json" \\',
  '  -H "X-WebHooker-Signature: sha256=$(hmac-sha256 "$BODY" "$SECRET")" \\',
  "  -d '{",
  '    "title": "Deploy failed",',
  '    "description": "Prod rollout failed at 12:03 UTC",',
  '    "color": "red",',
  '    "repo": "acme/widget",',
  '    "url": "https://ci.example.com/runs/42",',
  '    "fields": [{ "name": "Env", "value": "prod", "inline": true }]',
  "  }'",
].join("\n");

watch(
  () => props.groupId,
  () => {
    if (!props.canEdit) return;
    load();
  },
  { immediate: true },
);

async function load(): Promise<void> {
  error.value = "";
  try {
    info.value = await api.info(props.groupId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    info.value = null;
  }
}

async function onRegenerate(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    info.value = await api.regenerate(props.groupId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function onDisable(): Promise<void> {
  const confirmed = await confirm({
    title: t("confirm.disableWebhook"),
    description: t("confirm.disableWebhookDetail"),
    confirmText: t("webhook.disable"),
  });
  if (!confirmed) return;
  busy.value = true;
  error.value = "";
  try {
    await api.disable(props.groupId);
    info.value = { url: info.value?.url ?? "", hasSecret: false };
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>
