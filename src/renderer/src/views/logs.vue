<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { invoke, on } from '@utils/ipc'
import { formatDateTime } from '@utils/common'

const activeTab = ref('captures')
const captures = ref([])
const logs = ref([])

let offCapture = null
let offLog = null

async function load() {
  captures.value = (await invoke('captures:list')) || []
  logs.value = (await invoke('logs:list')) || []
}

async function clearActive() {
  if (activeTab.value === 'captures') {
    await invoke('captures:clear')
    captures.value = []
    ElMessage.success('已清空抓包记录')
    return
  }
  await invoke('logs:clear')
  logs.value = []
  ElMessage.success('已清空运行日志')
}

function statusClass(code) {
  if (!code || code >= 500) return 'fail'
  if (code >= 400) return 'warn'
  return 'ok'
}

function levelClass(level) {
  return `lv-${level || 'info'}`
}

const activeCount = computed(() =>
  activeTab.value === 'captures' ? captures.value.length : logs.value.length
)

onMounted(async () => {
  await load()
  offCapture = on('capture-batch', (batch) => {
    captures.value.push(...batch)
    if (captures.value.length > 300) {
      captures.value.splice(0, captures.value.length - 300)
    }
  })
  offLog = on('log', (entry) => {
    logs.value.push(entry)
    if (logs.value.length > 500) logs.value.shift()
  })
})

onUnmounted(() => {
  if (offCapture) offCapture()
  if (offLog) offLog()
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">抓包日志</h1>
        <p class="page-desc">
          只显示命中白名单域名的请求。直通流量不会被记录，也不在这里出现。
        </p>
      </div>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ active: activeTab === 'captures' }" @click="activeTab = 'captures'">
        请求记录
        <span class="count">{{ captures.length }}</span>
      </button>
      <button class="tab" :class="{ active: activeTab === 'logs' }" @click="activeTab = 'logs'">
        运行日志
        <span class="count">{{ logs.length }}</span>
      </button>
      <span class="spacer"></span>
      <el-button v-if="activeCount" size="small" text @click="clearActive">清空</el-button>
    </div>

    <template v-if="activeTab === 'captures'">
      <div v-if="!captures.length" class="empty-box">
        暂无请求。启动采集并在微信里打开小程序后，这里会出现被解密的请求。
      </div>
      <div v-else class="table">
        <div class="tr th">
          <span class="c-time">时间</span>
          <span class="c-method">方法</span>
          <span class="c-host">域名</span>
          <span class="c-path">路径</span>
          <span class="c-status">状态</span>
          <span class="c-dur">耗时</span>
        </div>
        <div v-for="row in captures.slice().reverse()" :key="row.id" class="tr">
          <span class="c-time mono">{{ (row.at || '').slice(11, 19) }}</span>
          <span class="c-method mono">{{ row.method }}</span>
          <span class="c-host mono" :title="row.host">{{ row.host }}</span>
          <span class="c-path mono" :title="row.path">{{ row.path }}</span>
          <span class="c-status mono" :class="statusClass(row.statusCode)">{{ row.statusCode }}</span>
          <span class="c-dur mono">{{ row.duration }}ms</span>
        </div>
      </div>
    </template>

    <template v-else>
      <div v-if="!logs.length" class="empty-box">暂无日志。</div>
      <div v-else class="log-list">
        <div v-for="(item, idx) in logs.slice().reverse()" :key="idx" class="log-row">
          <span class="log-time mono">{{ formatDateTime(item.at) }}</span>
          <span class="log-level mono" :class="levelClass(item.level)">{{ item.level }}</span>
          <span class="log-msg">{{ item.message }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line-soft);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--tx-3);
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}

.tab:hover {
  background: var(--bg-hover);
  color: var(--tx);
}

.tab.active {
  background: var(--bg-active);
  color: var(--tx);
  font-weight: 500;
}

.count {
  font-size: 10.5px;
  color: var(--tx-4);
  font-variant-numeric: tabular-nums;
}

.tab.active .count {
  color: var(--tx-3);
}

.spacer {
  flex: 1;
}

/* ---- 请求表 ---- */
.table {
  margin-top: 2px;
}

.tr {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 30px;
  padding: 0 10px;
  margin: 0 -10px;
  font-size: 11.5px;
  border-radius: 4px;
}

.tr.th {
  height: 26px;
  color: var(--tx-4);
  font-size: 11px;
}

.tr:not(.th):hover {
  background: var(--bg-hover);
}

.c-time {
  width: 62px;
  flex-shrink: 0;
  color: var(--tx-4);
}

.c-method {
  width: 44px;
  flex-shrink: 0;
  color: var(--tx-3);
}

.c-host {
  width: 180px;
  flex-shrink: 0;
  color: var(--tx-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-path {
  flex: 1;
  min-width: 0;
  color: var(--tx-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-status {
  width: 40px;
  flex-shrink: 0;
  text-align: right;
}

.c-status.ok {
  color: var(--ok);
}

.c-status.warn {
  color: var(--warn);
}

.c-status.fail {
  color: var(--err);
}

.c-dur {
  width: 54px;
  flex-shrink: 0;
  text-align: right;
  color: var(--tx-4);
}

/* ---- 运行日志 ---- */
.log-list {
  margin-top: 2px;
}

.log-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 5px 10px;
  margin: 0 -10px;
  font-size: 11.5px;
  border-radius: 4px;
}

.log-row:hover {
  background: var(--bg-hover);
}

.log-time {
  color: var(--tx-4);
  font-size: 11px;
  flex-shrink: 0;
}

.log-level {
  width: 42px;
  flex-shrink: 0;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.lv-info {
  color: var(--tx-4);
}

.lv-warn {
  color: var(--warn);
}

.lv-error {
  color: var(--err);
}

.log-msg {
  color: var(--tx-2);
  word-break: break-all;
}
</style>
