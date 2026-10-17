<template>
  <RcCard variant="outline" padding="md" class="members-panel">
    <div class="panel-head">
      <h3>{{ t("members.title") }}</h3>
      <span class="lbl-note">{{ t("members.note") }}</span>
    </div>

    <p v-if="!members.length" class="empty-log">{{ t("members.empty") }}</p>

    <ul class="member-grid">
      <li v-for="m in members" :key="m.login.toLowerCase()" class="member-card">
        <span class="member-name" :title="m.login">{{ m.login }}</span>
        <div class="member-role">
          <RcSelect
            v-if="canEdit"
            :model-value="m.role"
            :options="roleOptions"
            :disabled="saving"
            @update:model-value="onRoleChange(m, $event)"
          />
          <RcBadge v-else size="xs" class="role-pill" :class="m.role">{{
            t("roles." + m.role)
          }}</RcBadge>
        </div>
        <RcButton
          v-if="canEdit"
          type="button"
          variant="ghost"
          color="error"
          size="icon"
          class="h-8 w-8 text-muted hover:text-bad"
          :disabled="saving"
          :title="t('members.remove')"
          :aria-label="t('members.remove')"
          @click="removeMember(m)"
        >
          <Trash2 :size="15" />
        </RcButton>
      </li>
    </ul>

    <div v-if="canEdit" class="member-add">
      <div class="member-add-login">
        <RcInput
          v-model="newLogin"
          type="text"
          size="sm"
          :placeholder="t('members.addPlaceholder')"
          @keydown.enter.prevent="addMember"
        />
      </div>
      <div class="member-role">
        <RcSelect v-model="newRole" :options="roleOptions" />
      </div>
      <RcButton type="button" size="sm" class="h-9" :disabled="saving" @click="addMember">
        {{ t("members.addBtn") }}
      </RcButton>
    </div>

    <div v-if="canEdit" class="invite-box">
      <h4>
        {{ t("members.invites") }}
        <span class="lbl-note">{{ t("members.inviteNote") }}</span>
      </h4>
      <div class="invite-create">
        <div class="member-role">
          <RcSelect v-model="inviteRole" :options="inviteRoleOptions" />
        </div>
        <RcButton
          type="button"
          size="sm"
          class="h-9"
          :disabled="saving || inviting"
          @click="createInvite"
        >
          {{ t("members.createInvite") }}
        </RcButton>
      </div>
      <ul v-if="invites.length" class="invite-list">
        <li v-for="inv in invites" :key="inv.token" class="invite-row">
          <code class="invite-token">{{ shortToken(inv.token) }}</code>
          <RcBadge size="xs" class="role-pill" :class="inv.role">{{
            t("roles." + inv.role)
          }}</RcBadge>
          <span class="invite-exp">{{ fmtExp(inv.expiresAt) }}</span>
          <div class="invite-actions">
            <RcButton type="button" variant="ghost" size="sm" @click="copyInvite(inv)">
              {{ copied === inv.token ? t("members.copied") : t("members.copyLink") }}
            </RcButton>
            <RcButton type="button" variant="ghost" color="error" size="sm" @click="revoke(inv)">{{
              t("members.revoke")
            }}</RcButton>
          </div>
        </li>
      </ul>
      <p v-else class="empty-log">{{ t("members.noInvites") }}</p>
    </div>

    <div class="err">{{ formError }}</div>
  </RcCard>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { Trash2 } from "lucide-vue-next";
import type { Group, GroupInvite, GroupMember, GroupRole } from "~/types";
import { useInvitesApi } from "~/composables/useInvites";

const { t } = useI18n();
const { confirm } = useConfirm();

const props = defineProps<{ group: Group; canEdit: boolean; saving: boolean }>();
const emit = defineEmits<{ (e: "save", group: Group): void }>();

const invitesApi = useInvitesApi();
const members = ref<GroupMember[]>([]);
const invites = ref<GroupInvite[]>([]);
const newLogin = ref("");
const newRole = ref<GroupRole>("admin");
const inviteRole = ref<"admin" | "viewer">("admin");
const inviting = ref(false);
const formError = ref("");
const { copied, copy } = useCopy(2000);
const roleOptions = computed(() => [
  { label: t("roles.owner"), value: "owner" },
  { label: t("roles.admin"), value: "admin" },
  { label: t("roles.viewer"), value: "viewer" },
]);
const inviteRoleOptions = computed(() =>
  roleOptions.value.filter((option) => option.value !== "owner"),
);

watch(
  () => props.group,
  (g) => {
    members.value = (g.members ?? []).map((m) => ({ ...m }));
    formError.value = "";
    if (props.canEdit) loadInvites();
  },
  { immediate: true },
);

async function loadInvites(): Promise<void> {
  invites.value = await invitesApi.list(props.group.id);
}

function ownerCount(): number {
  return members.value.filter((m) => m.role === "owner").length;
}

function onRoleChange(m: GroupMember, role: string): void {
  const nextRole = role as GroupRole;
  if (nextRole === "viewer" && m.role === "owner" && ownerCount() === 1) {
    formError.value = t("members.errLastOwner");
    return;
  }
  m.role = nextRole;
  emitSave();
}

function addMember(): void {
  const login = newLogin.value.trim();
  if (!login) return;
  if (members.value.some((m) => m.login.toLowerCase() === login.toLowerCase())) {
    formError.value = t("members.errOwner");
    return;
  }
  members.value.push({ login, role: newRole.value });
  newLogin.value = "";
  emitSave();
}

async function removeMember(m: GroupMember): Promise<void> {
  formError.value = "";
  if (m.role === "owner" && ownerCount() === 1) {
    formError.value = t("members.errLastOwner");
    return;
  }
  const confirmed = await confirm({
    title: t("confirm.removeMember", { name: m.login }),
    confirmText: t("members.remove"),
  });
  if (!confirmed) return;
  members.value = members.value.filter((x) => x !== m);
  emitSave();
}

function emitSave(): void {
  emit("save", { ...props.group, members: members.value.map((m) => ({ ...m })) });
}

async function createInvite(): Promise<void> {
  inviting.value = true;
  formError.value = "";
  try {
    const url = await invitesApi.create(props.group.id, inviteRole.value);
    const token = url.split("token=")[1] ?? "";
    if (token) {
      invites.value = [
        {
          token,
          groupId: props.group.id,
          role: inviteRole.value,
          expiresAt: Date.now() + 7 * 86400_000,
          createdBy: "",
        },
        ...invites.value,
      ];
    }
    copy(`${window.location.origin}${url}`, token);
    await loadInvites();
  } catch (err) {
    formError.value = err instanceof Error ? err.message : String(err);
  } finally {
    inviting.value = false;
  }
}

async function copyInvite(inv: GroupInvite): Promise<void> {
  const url = `${window.location.origin}/admin/invite?token=${inv.token}`;
  await copy(url, inv.token);
}

async function revoke(inv: GroupInvite): Promise<void> {
  const confirmed = await confirm({
    title: t("confirm.revokeInvite"),
    confirmText: t("members.revoke"),
  });
  if (!confirmed) return;
  try {
    await invitesApi.revoke(inv.token);
    invites.value = invites.value.filter((i) => i.token !== inv.token);
  } catch (err) {
    formError.value = err instanceof Error ? err.message : String(err);
  }
}

function shortToken(token: string): string {
  return token.slice(0, 8) + "…";
}

function fmtExp(ts: number): string {
  return new Date(ts).toLocaleDateString();
}
</script>
