<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { invoke } from '@utils/ipc'
import Sidebar from './components/Sidebar/index.vue'

const running = ref(false)
const port = ref(0)

let timer = null

/**
 * 采集状态侧栏要用。主进程没有状态变更推送，
 * 这里用轻量轮询兜住，3 秒一次开销可忽略。
 */
async function poll() {
  try {
    const s = await invoke('proxy:status')
    running.value = Boolean(s?.running)
    port.value = s?.port || 0
  } catch {
    /* 轮询失败保持上一次状态，不打扰用户 */
  }
}

onMounted(() => {
  poll()
  timer = setInterval(poll, 3000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="shell">
    <Sidebar :running="running" :port="port" />
    <main class="content">
      <router-view />
    </main>
  </div>
</template>

<style lang="scss" scoped>
.shell {
  display: flex;
  height: 100%;
  overflow: hidden;
  background: var(--bg);
}

.content {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}
</style>
