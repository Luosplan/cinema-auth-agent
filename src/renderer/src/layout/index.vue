<script setup>
import { onMounted, onUnmounted } from 'vue'
import TitleBar from './components/TitleBar/index.vue'
import StatusBar from './components/StatusBar/index.vue'
import Traffic from '../views/traffic.vue'
import { startProxyPoll, stopProxyPoll } from '../stores/proxy'
import { ui } from '../stores/ui'

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
      <!--
        v-show 而不是 v-if：切回影城账号时，筛选条件、选中的出票系统、已经拉到的账号都还在，
        也不用重新请求一次影城树。
      -->
      <router-view v-show="ui.mode === 'cinemas'" />

      <!-- 网络抓包：和 Reqable 一样左边请求列表、右边报文详情 -->
      <Traffic v-show="ui.mode === 'traffic'" />
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
