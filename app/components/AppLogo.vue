<template>
  <img
    :src="size <= 32 ? '/icon-small.svg' : '/icon.svg'"
    :width="size"
    :height="size"
    alt="WebHooker"
    class="app-logo"
    :style="{ width: `${size}px`, height: `${size}px` }"
  />
</template>

<script setup lang="ts">
// 显示尺寸不超过 32px 时使用光学校正的小尺寸图标（品牌资产规范）。
withDefaults(
  defineProps<{
    size?: number;
  }>(),
  {
    size: 32,
  },
);
</script>

<style scoped>
.app-logo {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
}
</style>