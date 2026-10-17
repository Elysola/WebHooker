<template>
  <RcDialog
    :open="open"
    :title="isEdit ? t('groupEditor.editTitle') : t('groupEditor.newTitle')"
    class="editor-dialog flex flex-col gap-0 max-h-[calc(100dvh-2rem)] overflow-hidden p-0 max-w-2xl"
    @update:open="onOpenChange"
  >
    <template #header>
      <div class="editor-head">
        <div class="editor-heading">
          <span class="editor-eyebrow">{{ t("groupEditor.eyebrow") }}</span>
          <h2>{{ isEdit ? t("groupEditor.editTitle") : t("groupEditor.newTitle") }}</h2>
        </div>
      </div>
    </template>
    <form class="editor-body" @submit.prevent="save">
      <section class="editor-section">
        <h3 class="editor-section-title">{{ t("groupEditor.sectionBasic") }}</h3>
        <div class="row2">
          <div class="field">
            <label>{{ t("groupEditor.name") }}</label>
            <RcInput
              v-model="form.name"
              type="text"
              :placeholder="t('groupEditor.namePlaceholder')"
              required
            />
          </div>
          <div class="field">
            <label>{{ t("groupEditor.id") }}</label>
            <RcInput
              v-model="form.id"
              type="text"
              :placeholder="t('groupEditor.idPlaceholder')"
              required
            />
            <div class="hint">
              {{ isEdit ? t("groupEditor.renameHint") : t("groupEditor.idHint") }}
            </div>
          </div>
        </div>
      </section>
      <section class="editor-section">
        <h3 class="editor-section-title">{{ t("groupEditor.sectionPreferences") }}</h3>
        <div class="row2">
          <div class="field">
            <label>{{ t("groupEditor.language") }}</label>
            <RcInput
              v-model="form.lang"
              type="text"
              :placeholder="t('groupEditor.langPlaceholder')"
            />
            <div class="hint">{{ t("groupEditor.langHint") }}</div>
          </div>
          <div class="field">
            <label
              >{{ t("groupEditor.emoji") }}
              <span class="lbl-note">{{ t("groupEditor.emojiNote") }}</span></label
            >
            <RcSwitch v-model="form.emoji" :label="t('groupEditor.emojiLabel')" />
          </div>
        </div>
        <div class="field">
          <label
            >{{ t("groupEditor.forgeSources") }}
            <span class="lbl-note">{{ t("groupEditor.forgeSourcesNote") }}</span></label
          >
          <div v-for="(s, i) in form.forgeSources" :key="i" class="forge-source-row">
            <div class="f-host">
              <RcInput
                v-model="s.host"
                type="text"
                :placeholder="t('groupEditor.forgeSourcesHost')"
              />
            </div>
            <div class="f-type">
              <RcSelect
                v-model="s.type"
                :options="[
                  { label: 'GitHub', value: 'github' },
                  { label: 'Gitea', value: 'gitea' },
                ]"
              />
            </div>
            <RcButton
              type="button"
              variant="ghost"
              color="error"
              size="icon"
              class="f-del h-9 w-9 text-muted hover:text-bad"
              :title="t('groupEditor.forgeSourcesRemove')"
              :aria-label="t('groupEditor.forgeSourcesRemove')"
              @click="removeForgeSource(s)"
            >
              <Trash2 :size="15" />
            </RcButton>
            <div class="f-name">
              <RcInput
                v-model="s.name"
                type="text"
                :placeholder="t('groupEditor.forgeSourcesName')"
              />
            </div>
          </div>
          <RcButton type="button" variant="ghost" class="add-filter" @click="addForgeSource">
            {{ t("groupEditor.forgeSourcesAdd") }}
          </RcButton>
          <div class="hint">{{ t("groupEditor.forgeSourcesHint") }}</div>
        </div>
      </section>
      <section class="editor-section">
        <h3 class="editor-section-title">{{ t("groupEditor.sectionAccess") }}</h3>
        <div class="field">
          <label
            >{{ t("groupEditor.membersNote") }}
            <span class="lbl-note">{{ t("groupEditor.membersHint") }}</span></label
          >
          <p class="hint">
            {{ t("groupEditor.membersGoPanel") }}
          </p>
        </div>
        <div v-if="superAdmin" class="field">
          <label
            >{{ t("groupEditor.owners") }}
            <span class="lbl-note">{{ t("groupEditor.ownersNote") }}</span></label
          >
          <RcTagInput
            v-model="owners"
            separator=","
            :placeholder="t('groupEditor.ownersPlaceholder')"
          />
          <div class="hint">{{ t("groupEditor.ownersHint") }}</div>
        </div>
        <div v-else class="field">
          <label
            >{{ t("groupEditor.owners") }}
            <span class="lbl-note">{{ t("groupEditor.ownersSuperOnly") }}</span></label
          >
          <RcInput v-model="ownersReadonly" type="text" class="opacity-60" disabled />
        </div>
      </section>
      <section class="editor-section">
        <h3 class="editor-section-title">{{ t("groupEditor.sectionProviders") }}</h3>
        <div class="field">
          <label
            >{{ t("groupEditor.providers") }}
            <span class="lbl-note">{{ t("groupEditor.providersNote") }}</span></label
          >
          <div class="flex flex-wrap gap-4">
            <RcCheckbox
              :model-value="form.providers.includes('github')"
              label="GitHub"
              @update:model-value="toggleProvider('github', $event)"
            />
            <RcCheckbox
              :model-value="form.providers.includes('gitea')"
              label="Gitea"
              @update:model-value="toggleProvider('gitea', $event)"
            />
          </div>
          <div class="hint">{{ t("groupEditor.providersHint") }}</div>
        </div>
        <div class="field">
          <label
            >{{ t("groupEditor.installationId") }}
            <span class="lbl-note">{{ t("groupEditor.installationIdNote") }}</span></label
          >
          <div class="ctl-md">
            <RcInput
              v-model="form.installationId"
              type="text"
              inputmode="numeric"
              :placeholder="t('groupEditor.installationIdPlaceholder')"
            />
          </div>
          <div class="hint">{{ t("groupEditor.installationIdHint") }}</div>
        </div>
      </section>
      <section class="editor-section">
        <h3 class="editor-section-title">{{ t("groupEditor.sectionLog") }}</h3>
        <div class="field">
          <label
            >{{ t("groupEditor.logTarget") }}
            <span class="lbl-note">{{ t("groupEditor.logTargetNote") }}</span></label
          >
          <div class="ctl-md">
            <RcSelect
              :model-value="form.logPlatform || 'none'"
              :options="[
                { label: t('groupEditor.logDisabled'), value: 'none' },
                { label: 'Discord', value: 'discord' },
                { label: 'Telegram', value: 'telegram' },
                { label: t('groupEditor.logFeishu'), value: 'feishu' },
              ]"
              @update:model-value="
                form.logPlatform = ($event === 'none' ? '' : $event) as
                  '' | 'discord' | 'telegram' | 'feishu'
              "
            />
          </div>
          <div v-if="form.logPlatform" class="ctl-stack">
            <template v-if="form.logPlatform === 'discord'">
              <RcInput
                v-model="form.logChannelId"
                type="text"
                :placeholder="t('routeEditor.channelPlaceholder')"
              />
              <RcInput
                v-model="form.logThreadId"
                type="text"
                :placeholder="t('routeEditor.threadPlaceholder')"
              />
            </template>
            <template v-else>
              <RcInput
                v-model="form.logChatId"
                type="text"
                :placeholder="
                  form.logPlatform === 'telegram'
                    ? t('routeEditor.chatPlaceholder')
                    : t('routeEditor.feishuChatPlaceholder')
                "
              />
              <RcInput
                v-if="form.logPlatform === 'telegram'"
                v-model="form.logTopicId"
                type="text"
                :placeholder="t('routeEditor.topicPlaceholder')"
              />
            </template>
          </div>
          <div class="hint">{{ t("groupEditor.logTargetHint") }}</div>
        </div>
      </section>
      <div class="err">{{ formError }}</div>
    </form>
    <template #footer>
      <div class="editor-foot">
        <RcButton variant="ghost" type="button" @click="close">
          {{ t("groupEditor.cancel") }}
        </RcButton>
        <RcButton variant="primary" type="button" :loading="saving" @click="save">
          {{ t("groupEditor.save") }}
        </RcButton>
      </div>
    </template>
  </RcDialog>
</template>

<script setup lang="ts">
import { reactive, watch } from "vue";
import { Trash2 } from "lucide-vue-next";
import type { ForgeSource, Group } from "~/types";

const { t } = useI18n();
const { confirm } = useConfirm();

const props = defineProps<{
  open: boolean;
  group: Group | null;
  saving: boolean;
  superAdmin?: boolean;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "save", group: Group): void;
}>();

const isEdit = computed(() => props.group != null);
const formError = ref("");
const ownersReadonly = computed(() => (props.group?.owners ?? []).join(", "));

const form = reactive({
  id: "",
  name: "",
  owners: "",
  providers: [] as ("github" | "gitea")[],
  installationId: "",
  emoji: true,
  forgeSources: [] as ForgeSource[],
  lang: "",
  logPlatform: "" as "" | "discord" | "telegram" | "feishu",
  logChannelId: "",
  logThreadId: "",
  logChatId: "",
  logTopicId: "",
});
const owners = computed({
  get: () =>
    form.owners
      .split(",")
      .map((owner) => owner.trim())
      .filter(Boolean),
  set: (values: string[]) => {
    form.owners = values.join(", ");
  },
});

function addForgeSource(): void {
  form.forgeSources.push({ host: "", type: "github" });
}

async function removeForgeSource(source: ForgeSource): Promise<void> {
  const label = source.host.trim() || source.name?.trim();
  if (label && !(await confirm({ title: t("confirm.removeForgeSource", { name: label }) }))) {
    return;
  }
  const index = form.forgeSources.indexOf(source);
  if (index >= 0) form.forgeSources.splice(index, 1);
}
function toggleProvider(p: "github" | "gitea", checked: boolean): void {
  form.providers = checked
    ? [...new Set([...form.providers, p])]
    : form.providers.filter((x) => x !== p);
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const g = props.group;
    const lt = g?.logTarget;
    form.id = g?.id ?? "";
    form.name = g?.name ?? "";
    form.owners = (g?.owners ?? []).join(", ");
    form.providers = (g?.providers ?? []).filter(
      (p): p is "github" | "gitea" => p === "github" || p === "gitea",
    );
    form.installationId = g?.installationId != null ? String(g.installationId) : "";
    form.emoji = g?.emoji ?? true;
    form.forgeSources = (g?.forgeSources ?? []).map((s) => ({ ...s }));
    form.lang = g?.lang ?? "";
    form.logPlatform = lt?.platform ?? "";
    form.logChannelId = lt?.channelId ?? "";
    form.logThreadId = lt?.threadId ?? "";
    form.logChatId = lt?.chatId ?? "";
    form.logTopicId = lt?.topicId ?? "";
    formError.value = "";
  },
);

function close(): void {
  emit("close");
}

// A click on the backdrop must not discard what has been typed so far.
const { isBackdropClose } = useBackdropGuard(() => props.open, ".editor-dialog");
useDialogFocus(() => props.open, ".editor-dialog");

function onOpenChange(open: boolean): void {
  if (!open && !isBackdropClose()) close();
}

function save(): void {
  formError.value = "";
  const id = form.id.trim();
  const name = form.name.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    formError.value = t("groupEditor.errIdFormat");
    return;
  }
  if (!name) {
    formError.value = t("groupEditor.errName");
    return;
  }
  let logTarget:
    | { platform: "discord"; channelId: string; threadId?: string }
    | { platform: "telegram"; chatId: string; topicId?: string }
    | { platform: "feishu"; chatId: string }
    | undefined;
  if (form.logPlatform === "discord") {
    const channelId = form.logChannelId.trim();
    if (!channelId) {
      formError.value = t("groupEditor.errLogChannel");
      return;
    }
    logTarget = { platform: "discord", channelId, threadId: form.logThreadId.trim() || undefined };
  } else if (form.logPlatform === "telegram") {
    const chatId = form.logChatId.trim();
    if (!chatId) {
      formError.value = t("groupEditor.errLogChat");
      return;
    }
    logTarget = { platform: "telegram", chatId, topicId: form.logTopicId.trim() || undefined };
  } else if (form.logPlatform === "feishu") {
    const chatId = form.logChatId.trim();
    if (!chatId) {
      formError.value = t("groupEditor.errLogFeishuChat");
      return;
    }
    logTarget = { platform: "feishu", chatId };
  }
  const installationText = form.installationId.trim();
  let installationId: number | undefined;
  if (installationText) {
    installationId = Number(installationText);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      formError.value = t("groupEditor.errInstallationId");
      return;
    }
  }
  for (const s of form.forgeSources) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(s.host.trim())) {
      formError.value = t("groupEditor.errForgeSourceHost");
      return;
    }
  }
  const owners = splitList(form.owners);
  const members = props.group?.members
    ? props.group.members.map((m) => ({ ...m }))
    : props.group?.adminIds?.length
      ? props.group.adminIds.map((login) => ({ login, role: "owner" as const }))
      : [];
  emit("save", {
    id,
    name,
    members,
    adminIds: members.filter((m) => m.role === "owner").map((m) => m.login),
    owners: props.superAdmin ? (owners.length ? owners : undefined) : props.group?.owners,
    providers: form.providers.length ? form.providers : undefined,
    installationId,
    emoji: form.emoji,
    forgeSources: form.forgeSources.length
      ? form.forgeSources.map((s) => ({
          host: s.host.trim(),
          type: s.type,
          ...(s.name?.trim() ? { name: s.name.trim() } : {}),
        }))
      : undefined,
    lang: form.lang.trim() || undefined,
    logTarget,
  });
}
</script>

<style scoped>
:deep(.editor-foot) {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  border-top: 1px solid rgb(var(--wh-border));
  background: rgb(var(--wh-surface));
  padding: 1rem 1.5rem;
  box-shadow: 0 -8px 24px -16px rgba(15, 23, 42, 0.18);
}
</style>
