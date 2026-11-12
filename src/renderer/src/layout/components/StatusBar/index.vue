<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { invoke } from '@utils/ipc'
import { proxyStatus, refreshProxyStatus } from '@renderer/stores/proxy'
import { cinemaStats } from '@renderer/stores/stats'
import { auth, loadAuth } from '@renderer/stores/auth'
import { caInfo, refreshCa } from '@renderer/stores/ca'
import { openSettings } from '@renderer/stores/ui'

/**
 * 底部状态栏。
 *
 * 只放「一直想知道、但不值得占一块版面」的东西：
 * 左下是数据规模，右下是采集状态、证书状态和版本号。
 * 采集开关本身在标题栏，这里只读状态，不重复放按钮；
 * 证书的安装/卸载也统一收进设置弹窗，这里只当入口。
 */
const version = ref('')

const summary = computed(() => {
  // 没登录时影城树本来就是空的，直接说「未登录」，别报成「共 0 家影城」
  if (!auth.loggedIn) return auth.loaded ? '未登录' : ''
  if (!cinemaStats.loaded) return '正在读取影城数据…'
  return `共 ${cinemaStats.cinemas} 家影城 · ${cinemaStats.accounts} 个账号`
})

const runningText = computed(() => {
  if (!proxyStatus.running) return '未采集'
  return proxyStatus.port ? `采集中 127.0.0.1:${proxyStatus.port}` : '采集中'
})

/** 证书点击直接落到设置弹窗的「根证书」那一栏 */
function openCa() {
  refreshCa()
  openSettings('ca')
}

/**
 * 回到窗口时复核证书状态。
 * 没有系统级的事件通知，只能靠焦点变化兜住「去 certmgr 里手动删了证书」这种操作。
 */
function onFocus() {
  refreshCa()
}

onMounted(async () => {
  loadAuth()
  refreshCa()
  refreshProxyStatus()
  window.addEventListener('focus', onFocus)
  try {
    const info = await invoke('app:info')
    version.value = info?.version || ''
  } catch {
    /* 版本号读不到就不显示 */
  }
})

onUnmounted(() => {
  window.removeEventListener('focus', onFocus)
})
</script>

<template>
  <footer class="sbar">
    <span class="sum">{{ summary }}</span>

    <div class="right">
      <span class="stat" :class="{ on: proxyStatus.running }">
        <span class="dot"></span>
        {{ runningText }}
      </span>

      <span class="sep"></span>

      <button
        class="stat ca"
        :class="{ warn: !caInfo.installed }"
        :title="caInfo.installed ? '根证书已安装，点击查看' : '根证书未安装，抓不到 HTTPS 内容'"
        @click="openCa"
      >
        <svg viewBox="0 0 24 24" class="ico">
          <path d="M12 3l7 3v5.5c0 4.3-2.9 7.9-7 9.5-4.1-1.6-7-5.2-7-9.5V6z" />
          <path v-if="caInfo.installed" d="m9 12 2.2 2.2L15.4 10" />
          <path v-else d="M12 8.6v4M12 15.4v.1" />
        </svg>
        证书 {{ caInfo.installed ? '已安装' : '未安装' }}
      </button>

      <span v-if="version" class="sep"></span>
      <span v-if="version" class="stat ver mono">v{{ version }}</span>
    </div>
  </footer>
</template>

<style lang="scss" scoped>
.sbar {
  height: 28px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 12px;
  border-top: 1px solid var(--line);
  background: var(--bg-panel);
  font-size: 11px;
  color: var(--tx-4);
}

.sum {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/* 右侧三组信息用细线分开，比加大间距更省地方也更整齐 */
.sep {
  width: 1px;
  height: 11px;
  flex-shrink: 0;
  background: var(--line-strong);
}

.stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--tx-3);
  font-family: inherit;
  font-size: 11px;
  white-space: nowrap;
}

/* 采集状态是只读指示，不要 hover 反馈，避免看起来像按钮 */
.stat:not(.ca) {
  cursor: default;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tx-4);
}

.stat.on {
  color: var(--tx-2);
}

.stat.on .dot {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-bg);
}

.ca {
  cursor: pointer;
}

.ca:hover {
  background: var(--bg-active);
  color: var(--tx-2);
}

.ca.warn {
  color: var(--warn);
}

.ca.warn:hover {
  background: var(--warn-bg);
}

.ico {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.ver {
  padding-left: 0;
  margin-left: 0;
  border-left: none;
  color: var(--tx-4);
}
</style>
