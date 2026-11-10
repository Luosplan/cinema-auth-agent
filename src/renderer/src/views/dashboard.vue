<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invoke, on } from '@utils/ipc'
import {
  formatDateTime,
  formatDuration,
  levelOfRemaining,
  LEVEL_TEXT,
  LEVEL_TYPE
} from '@utils/common'

const status = ref({ running: false, port: 0, stats: {} })
const credentials = ref([])
const caInfo = ref({ installed: false, fingerprint: '' })
const switching = ref(false)
const installing = ref(false)
const now = ref(Date.now())

let tickTimer = null
let offCredential = null

const sortedCredentials = computed(() =>
  [...credentials.value].sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0))
)

function remainingOf(row) {
  if (!row.expiresAt) return null
  return Math.round((row.expiresAt - now.value) / 1000)
}

function levelOf(row) {
  return levelOfRemaining(remainingOf(row))
}

function remainingText(row) {
  const s = remainingOf(row)
  if (s == null) return '未提供过期时间'
  return formatDuration(s)
}

async function refresh() {
  try {
    const [s, c, ca] = await Promise.all([
      invoke('proxy:status'),
      invoke('credentials:list'),
      invoke('ca:info')
    ])
    status.value = s || { running: false, stats: {} }
    credentials.value = c || []
    caInfo.value = ca || { installed: false }
  } catch (e) {
    ElMessage.error(`读取状态失败：${e.message}`)
  }
}

async function toggleProxy() {
  switching.value = true
  try {
    const res = status.value.running
      ? await invoke('proxy:stop')
      : await invoke('proxy:start')
    if (res?.error) {
      ElMessage.error(res.error)
    } else {
      ElMessage.success(res?.running ? '采集已启动' : '采集已停止')
    }
    await refresh()
  } finally {
    switching.value = false
  }
}

async function installCa() {
  installing.value = true
  try {
    const res = await invoke('ca:install')
    if (res?.ok) ElMessage.success('根证书已安装')
    else ElMessage.error(res?.message || '安装失败')
    await refresh()
  } finally {
    installing.value = false
  }
}

async function copyToken(row) {
  const res = await invoke('credentials:copy', { ruleId: row.ruleId })
  if (!res?.ok) {
    ElMessage.error(res?.message || '读取失败')
    return
  }
  try {
    await navigator.clipboard.writeText(res.token)
    ElMessage.success('凭证已复制到剪贴板')
  } catch {
    ElMessage.warning('剪贴板不可用，请检查系统权限')
  }
}

async function removeCredential(row) {
  try {
    await ElMessageBox.confirm(`确定清除「${row.taskName}」的凭证吗？`, '确认清除', {
      confirmButtonText: '清除',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  await invoke('credentials:remove', { ruleId: row.ruleId })
  ElMessage.success('已清除')
  await refresh()
}

onMounted(async () => {
  await refresh()
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 10000)
  offCredential = on('credential-updated', () => refresh())
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
  if (offCredential) offCredential()
})
</script>

<template>
  <div class="page">
    <section class="status-card">
      <div class="status-main">
        <div class="status-left">
          <span class="pulse" :class="{ on: status.running }"></span>
          <div>
            <div class="status-title">{{ status.running ? '采集中' : '未开始采集' }}</div>
            <div class="status-desc">
              <template v-if="status.running">
                系统代理已接管 · 监听 127.0.0.1:{{ status.port }}
              </template>
              <template v-else> 启动后由客户端自动截获小程序的登录凭证 </template>
            </div>
          </div>
        </div>
        <el-button
          :type="status.running ? 'default' : 'primary'"
          :loading="switching"
          @click="toggleProxy"
        >
          {{ status.running ? '停止采集' : '开始采集' }}
        </el-button>
      </div>

      <div class="status-metrics">
        <div class="metric">
          <div class="metric-value">{{ status.stats?.intercepted ?? 0 }}</div>
          <div class="metric-label">已解密请求</div>
        </div>
        <div class="metric">
          <div class="metric-value">{{ status.stats?.tunneled ?? 0 }}</div>
          <div class="metric-label">直通请求</div>
        </div>
        <div class="metric">
          <div class="metric-value">{{ credentials.length }}</div>
          <div class="metric-label">持有凭证</div>
        </div>
      </div>

      <div class="ca-bar" :class="{ warn: !caInfo.installed }">
        <span class="ca-text">
          <template v-if="caInfo.installed">根证书已安装，可正常解密 HTTPS</template>
          <template v-else>根证书未安装，抓到的内容无法解密</template>
        </span>
        <el-button v-if="!caInfo.installed" size="small" :loading="installing" @click="installCa">
          立即安装
        </el-button>
      </div>
    </section>

    <section class="list">
      <div class="list-head">
        <h3>凭证状态</h3>
        <span class="list-hint">按剩余有效期排序</span>
      </div>

      <div v-if="!sortedCredentials.length" class="empty">
        <div class="empty-title">还没有采集到任何凭证</div>
        <div class="empty-desc">
          请先在「系统配置」里填写影城接口域名，然后在微信里正常打开一次该影城的小程序。
        </div>
      </div>

      <div v-for="row in sortedCredentials" :key="row.ruleId" class="cred-card">
        <div class="cred-top">
          <div class="cred-name">
            {{ row.taskName }}
            <el-tag size="small" :type="LEVEL_TYPE[levelOf(row)]" effect="light">
              {{ row.expiresAt ? remainingText(row) : LEVEL_TEXT[levelOf(row)] }}
            </el-tag>
          </div>
          <div class="cred-actions">
            <el-button size="small" @click="copyToken(row)">复制</el-button>
            <el-button size="small" text @click="removeCredential(row)">清除</el-button>
          </div>
        </div>

        <div class="cred-meta">
          <div class="meta-item">
            <span class="meta-key">账号</span>
            <span class="meta-val">{{ row.account || '未识别' }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-key">凭证</span>
            <span class="meta-val mono">{{ row.tokenMasked }}</span>
          </div>
          <div class="meta-item">
            <span class="meta-key">更新</span>
            <span class="meta-val">{{ formatDateTime(row.updatedAt) }}</span>
          </div>
        </div>

        <div class="cred-source mono">{{ row.source }}</div>
      </div>
    </section>
  </div>
</template>

<style lang="scss" scoped>
.page {
  height: 100%;
  overflow-y: auto;
  padding: 18px 20px 40px;
}

.status-card {
  background: #fff;
  border: 1px solid #e8eaf0;
  border-radius: 12px;
  padding: 18px 20px 14px;
}

.status-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.status-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pulse {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #c3c9d6;
  flex-shrink: 0;
}

.pulse.on {
  background: #2fa36b;
  box-shadow: 0 0 0 4px rgba(47, 163, 107, 0.12);
}

.status-title {
  font-size: 15px;
  font-weight: 500;
  color: #1b2330;
}

.status-desc {
  font-size: 12px;
  color: #8b94a4;
  margin-top: 4px;
}

.status-metrics {
  display: flex;
  gap: 36px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid #f0f2f7;
}

.metric-value {
  font-size: 19px;
  font-weight: 500;
  color: #1b2330;
  font-variant-numeric: tabular-nums;
}

.metric-label {
  font-size: 11px;
  color: #9aa3b2;
  margin-top: 2px;
}

.ca-bar {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #f4f8f5;
  border: 1px solid #e2efe8;
  border-radius: 8px;
  padding: 9px 12px;
}

.ca-bar.warn {
  background: #fdf6f0;
  border-color: #f6e3d3;
}

.ca-text {
  font-size: 12px;
  color: #5a6474;
}

.list {
  margin-top: 22px;
}

.list-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.list-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: #1b2330;
}

.list-hint {
  font-size: 11px;
  color: #a8b0be;
}

.empty {
  background: #fff;
  border: 1px dashed #dfe3ec;
  border-radius: 12px;
  padding: 34px 24px;
  text-align: center;
}

.empty-title {
  font-size: 13px;
  color: #4a5568;
}

.empty-desc {
  font-size: 12px;
  color: #9aa3b2;
  margin-top: 8px;
  line-height: 1.7;
}

.cred-card {
  background: #fff;
  border: 1px solid #e8eaf0;
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 10px;
}

.cred-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.cred-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  color: #1b2330;
}

.cred-meta {
  display: flex;
  gap: 28px;
  margin-top: 10px;
}

.meta-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
}

.meta-key {
  color: #9aa3b2;
}

.meta-val {
  color: #3d4657;
}

.cred-source {
  margin-top: 8px;
  font-size: 11px;
  color: #b3bbc9;
  word-break: break-all;
}
</style>
