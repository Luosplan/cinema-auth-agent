<script setup>
/**
 * 设置左栏的图标。
 *
 * 单独拆一个组件而不是 v-html 拼字符串：图标都是 24 格 stroke 图形，
 * 统一在这里改线宽/圆角，改一处全对。
 */
defineProps({
  name: { type: String, required: true }
})
</script>

<template>
  <svg class="sicon" viewBox="0 0 24 24" aria-hidden="true">
    <!-- 通用：两根带旋钮的滑杆 -->
    <template v-if="name === 'sliders'">
      <path d="M4 8h5M15 8h5M4 16h9M19 16h1" />
      <circle cx="12" cy="8" r="2.2" />
      <circle cx="16.5" cy="16" r="2.2" />
    </template>

    <!-- 账号 -->
    <template v-else-if="name === 'user'">
      <circle cx="12" cy="8.2" r="3.6" />
      <path d="M4.6 20c1.2-3.6 3.9-5.4 7.4-5.4s6.2 1.8 7.4 5.4" />
    </template>

    <!-- 运行状态：心跳线 -->
    <template v-else-if="name === 'pulse'">
      <path d="M3 12.5h3.4l2.2-6.2 3.9 11.6 2.4-5.4H21" />
    </template>

    <!-- 凭证库：卡片堆 -->
    <template v-else-if="name === 'card'">
      <rect x="3.4" y="6" width="17.2" height="12" rx="2.6" />
      <path d="M3.4 10.2h17.2M7.4 14.4h3.6" />
    </template>

    <!-- 凭证上报：上传 -->
    <template v-else-if="name === 'upload'">
      <path d="M12 16.4V4.6M8.2 8.4 12 4.6l3.8 3.8" />
      <path d="M4.4 15.2v3.2A1.6 1.6 0 0 0 6 20h12a1.6 1.6 0 0 0 1.6-1.6v-3.2" />
    </template>

    <!-- 运行日志：清单 -->
    <template v-else-if="name === 'list'">
      <path d="M4 6.4h4.6M4 12h9M4 17.6h6" />
      <path d="m15 16.6 2.6 2.6 3.4-4" />
    </template>

    <!-- 根证书：盾牌 -->
    <template v-else-if="name === 'shield'">
      <path d="M12 3.2 19 6v5.6c0 4.3-2.9 7.9-7 9.4-4.1-1.5-7-5.1-7-9.4V6z" />
      <path d="m9.2 12 2.1 2.1 3.9-4" />
    </template>

    <!-- 关于 -->
    <template v-else-if="name === 'info'">
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 11.2v5.4M12 8v.1" />
    </template>

    <!-- 搜索框前缀 -->
    <template v-else-if="name === 'search'">
      <circle cx="10.8" cy="10.8" r="6.4" />
      <path d="m15.6 15.6 4 4" />
    </template>
  </svg>
</template>

<style lang="scss" scoped>
.sicon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
