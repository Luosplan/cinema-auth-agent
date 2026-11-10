<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { invoke, on } from '@utils/ipc'
import { formatDateTime } from '@utils/common'

const activeTab = ref('captures')
const captures = ref([])
const logs = ref([])
const autoScroll = ref(true)

let offCapture = null
let offLog = null

async function load() {
  captures.value = (await invoke('captures:list')) || []
  logs.value = (await invoke('logs:list')) || []
}

async function clearCaptures() {
  await invoke('captures:clear')
  captures.value = []
  ElMessage.success('已清空抓包记录')
}

async function clearLogs() {
  await invoke('logs:clear')
  logs.value = []
  ElMessage.success('已清空运行日志')
}

function statusClass(code) {
  if (!code) return 'st-fail'
  if (code >= 500) return 'st-fail'
  if (code >= 400) return 'st-warn'
  return 'st-ok'
}

function levelClass(level) {
  return `lv-${level || 'info'}`
}

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
      <h2>抓包日志</h2>
      <p>这里只显示命中白名单域名的请求。直通的流量不会出现在这里，也不会被记录。</p>
    </div>

    <el-tabs v-model="activeTab">
      <el-tab-pane :label="`请求记录 ${captures.length}`" name="captures">
        <div class="toolbar">
          <el-button size="small" @click="clearCaptures">清空</el-button>
        </div>
        <div v-if="!captures.length" class="empty">暂无请求。启动采集并打开小程序后会出现。</div>
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
            <span class="c-status mono" :class="statusClass(row.statusCode)">
              {{ row.statusCode }}
            </span>
            <span class="c-dur mono">{{ row.duration }}ms</span>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane :label="`运行日志 ${logs.length}`" name="logs">
        <div class="toolbar">
          <el-button size="small" @click="clearLogs">清空</el-button>
        </div>
        <div v-if="!logs.length" class="empty">暂无日志</div>
        <div v-else class="log-list">
          <div v-for="(item, idx) in logs.slice().reverse()" :key="idx" class="log-row">
            <span class="log-time mono">{{ formatDateTime(item.at) }}</span>
            <span class="log-level" :class="levelClass(item.level)">{{ item.level }}</span>
            <span class="log-msg">{{ item.message }}</span>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style lang="scss" scoped>
.page {
  height: 100%;
  overflow-y: auto;
  padding: 18px 20px 40px;
}

.page-head h2 {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 500;
  color: #1b2330;
}

.page-head p {
  margin: 0 0 8px;
  font-size: 12px;
  color: #8b94a4;
  line-height: 1.8;
}

.toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.empty {
  text-align: center;
  color: #a8b0be;
  font-size: 12px;
  padding: 40px;
}

.table {
  background: #fff;
  border: 1px solid #e8eaf0;
  border-radius: 10px;
  overflow: hidden;
}

.tr {
  display: flex;
  align-items: center;
  padding: 8px 14px;
  font-size: 12px;
  border-bottom: 1px solid #f4f6fa;
}

.tr:last-child {
  border-bottom: none;
}

.tr.th {
  background: #fafbfd;
  color: #8b94a4;
  font-size: 11px;
}

.tr:hover:not(.th) {
  background: #fafcff;
}

.c-time {
  width: 74px;
  color: #9aa3b2;
  flex-shrink: 0;
}

.c-method {
  width: 56px;
  color: #5a6474;
  flex-shrink: 0;
}

.c-host {
  width: 190px;
  color: #3d4657;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-path {
  flex: 1;
  min-width: 0;
  color: #4a5568;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.c-status {
  width: 52px;
  flex-shrink: 0;
  text-align: right;
}

.st-ok {
  color: #2fa36b;
}

.st-warn {
  color: #d98b26;
}

.st-fail {
  color: #d05555;
}

.c-dur {
  width: 66px;
  flex-shrink: 0;
  text-align: right;
  color: #b3bbc9;
}

.log-list {
  background: #fff;
  border: 1px solid #e8eaf0;
  border-radius: 10px;
  padding: 6px 0;
}

.log-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 14px;
  font-size: 12px;
  border-bottom: 1px solid #f7f8fb;
}

.log-row:last-child {
  border-bottom: none;
}

.log-time {
  color: #b3bbc9;
  font-size: 11px;
  flex-shrink: 0;
}

.log-level {
  width: 44px;
  flex-shrink: 0;
  font-size: 11px;
  text-transform: uppercase;
}

.lv-info {
  color: #2fa36b;
}

.lv-warn {
  color: #d98b26;
}

.lv-error {
  color: #d05555;
}

.log-msg {
  color: #4a5568;
  word-break: break-all;
}
</style>
