<script setup>
import { onMounted, onUnmounted } from 'vue'
import TitleBar from './components/TitleBar/index.vue'
import StatusBar from './components/StatusBar/index.vue'
import { startProxyPoll, stopProxyPoll } from '../stores/proxy'

/**
 * 外壳：自绘标题栏（窗口是 frame:false）+ 内容 + 底部状态栏。
 *
 * 采集状态在这里统一轮询：标题栏的播放/暂停和状态栏的指示灯都读同一个单例，
 * 各自轮询会打双份 IPC。
 */
onMounted(() => startProxyPoll())
onUnmounted(() => stopProxyPoll())
</script>

<template>
  <div class="shell">
    <TitleBar />
    <main class="content">
      <router-view />
    </main>
    <StatusBar />
  </div>
</template>

<style lang="scss" scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg);
}

.content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
