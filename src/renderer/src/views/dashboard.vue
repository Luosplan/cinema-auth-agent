<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invoke, on } from '@utils/ipc'
import { formatDateTime, formatDuration, levelOfRemaining, LEVEL_TEXT } from '@utils/common'

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

/** 健康度映射到 pill 的配色，页面里不再关心具体色值 */
function levelClass(row) {
  const level = levelOf(row)
  if (level === 'healthy') return 'ok'
  if (level === 'warning') return 'warn'
  if (level === 'danger' || level === 'expired') return 'err'
  return ''
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
  // 有附加字段的系统（鲸鱼）一次给全，直接是一段能贴进后台配置的 JSON
  const extras = res.extras && Object.keys(res.extras).length ? res.extras : null
  const text = extras ? JSON.stringify({ accessToken: res.token, ...extras }, null, 2) : res.token
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(extras ? '凭证和附加字段已复制（JSON）' : '凭证已复制到剪贴板')
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
    <div class="page-inner">
      <div class="page-head">
        <div>
          <h1 class="page-title">概览</h1>
          <p class="page-desc">操作员正常使用小程序时顺手截获登录凭证，无需额外操作。</p>
        </div>
        <div class="page-head-actions">
          <el-button
            :type="status.running ? 'default' : 'primary'"
            :loading="switching"
            @click="toggleProxy"
          >
            {{ status.running ? '停止采集' : '开始采集' }}
          </el-button>
        </div>
      </div>

      <!-- 采集状态 -->
      <div class="state">
        <div class="state-main">
          <span class="led" :class="{ on: status.running }"></span>
          <div class="state-text">
            <div class="state-title">{{ status.running ? '正在采集' : '采集未启动' }}</div>
            <div class="state-desc">
              <template v-if="status.running">
                系统代理指向 127.0.0.1:{{ status.port }}，只解密白名单域名
              </template>
              <template v-else>启动后接管系统代理，停止或退出时自动还原</template>
            </div>
          </div>
        </div>

        <div class="metrics">
          <div class="metric">
            <div class="v">{{ status.stats?.intercepted ?? 0 }}</div>
            <div class="k">已解密</div>
          </div>
          <div class="metric">
            <div class="v">{{ status.stats?.tunneled ?? 0 }}</div>
            <div class="k">直通</div>
          </div>
          <div class="metric">
            <div class="v">{{ credentials.length }}</div>
            <div class="k">凭证</div>
          </div>
        </div>
      </div>

      <div v-if="!caInfo.installed" class="notice">
        <span>根证书未安装，抓到的 HTTPS 内容无法解密。</span>
        <el-button size="small" type="primary" :loading="installing" @click="installCa">
          立即安装
        </el-button>
      </div>

      <section class="section">
        <div class="section-head">
          <h2 class="section-title">凭证</h2>
          <span class="section-hint">按剩余有效期排序</span>
        </div>

        <div v-if="!sortedCredentials.length" class="empty-box">
          还没有采集到凭证。到
          <router-link class="link" to="/cinemas">影城账号</router-link>
          打开参数弹窗，在微信里正常打开一次该影城的小程序。
        </div>

        <div v-else class="cred-list">
          <div v-for="row in sortedCredentials" :key="row.ruleId" class="cred">
            <div class="cred-left">
              <div class="cred-title">
                <span class="cred-name">{{ row.taskName }}</span>
                <span class="pill" :class="levelClass(row)">
                  {{ row.expiresAt ? remainingText(row) : LEVEL_TEXT[levelOf(row)] }}
                </span>
              </div>
              <div class="cred-sub mono">
                <span>{{ row.account || '未识别账号' }}</span>
                <span class="sep">/</span>
                <span class="tok">{{ row.tokenMasked }}</span>
              </div>
              <div v-if="row.extraKeys?.length" class="cred-extra mono">
                {{ row.extraKeys.map((k) => `${k}=${row.extrasMasked?.[k] || ''}`).join('  ') }}
              </div>
              <div v-if="row.source" class="cred-src mono">{{ row.source }}</div>
            </div>

            <div class="cred-right">
              <div class="cred-time">{{ formatDateTime(row.updatedAt) }}</div>
              <div class="cred-ops">
                <el-button size="small" @click="copyToken(row)">复制</el-button>
                <el-button size="small" text @click="removeCredential(row)">清除</el-button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
/* ---- 采集状态 ---- */
.state {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--bg);
}

.state-main {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
}

.led {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tx-4);
  flex-shrink: 0;
}

.led.on {
  background: var(--ok);
  box-shadow: 0 0 0 4px var(--ok-bg);
}

.state-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--tx);
  letter-spacing: -0.01em;
}

.state-desc {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--tx-3);
}

.metrics {
  display: flex;
  flex-shrink: 0;
}

.metric {
  padding: 0 20px;
  text-align: right;
  border-left: 1px solid var(--line-soft);
}

.metric:first-child {
  border-left: none;
}

.metric .v {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--tx);
  line-height: 1.2;
}

.metric .k {
  font-size: 11px;
  color: var(--tx-4);
}

/* ---- 证书告警 ---- */
.notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 10px;
  padding: 9px 14px;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-bg);
  border-radius: var(--radius);
}

/* ---- 凭证列表 ---- */
.cred-list {
  margin-top: 2px;
}

.cred {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 12px 10px;
  margin: 0 -10px;
  border-bottom: 1px solid var(--line-soft);
  border-radius: var(--radius);
  transition: background 0.12s ease;
}

.cred:hover {
  background: var(--bg-hover);
}

.cred:last-child {
  border-bottom: none;
}

.cred-left {
  min-width: 0;
}

.cred-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cred-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--tx);
}

.cred-sub {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--tx-3);
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.cred-sub .sep {
  color: var(--tx-4);
}

.cred-sub .tok {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cred-extra {
  margin-top: 3px;
  font-size: 11px;
  color: var(--tx-3);
}

.cred-src {
  margin-top: 3px;
  font-size: 10.5px;
  color: var(--tx-4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cred-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
}

.cred-time {
  font-size: 11px;
  color: var(--tx-4);
  font-variant-numeric: tabular-nums;
}

.cred-ops {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0.72;
  transition: opacity 0.12s ease;
}

.cred:hover .cred-ops {
  opacity: 1;
}
</style>
