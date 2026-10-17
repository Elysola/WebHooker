<script setup lang="ts">
import { parseAdminPath } from "~/utils/admin-path";

definePageMeta({
  // Unknown console paths (e.g. /admin/foo, /admin/groups/a/b) 404 before rendering.
  validate: (route) => parseAdminPath(route.params.slug) !== null,
});
</script>

<template>
  <ConsolePage />
</template>
