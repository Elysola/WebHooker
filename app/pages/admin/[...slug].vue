<script setup lang="ts">
import { parseAdminPath } from "~/utils/admin-path";

definePageMeta({
  // One console for every /admin path: switching pages keeps its state (and
  // its in-flight saves) instead of mounting a fresh copy per URL.
  key: "admin-console",
  // Unknown console paths (e.g. /admin/foo, /admin/groups/a/b) 404 before rendering.
  validate: (route) => parseAdminPath(route.params.slug) !== null,
});
</script>

<template>
  <ConsolePage />
</template>
