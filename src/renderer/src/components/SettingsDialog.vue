<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invoke, on } from '@utils/ipc'
import { formatDateTime, formatDuration, levelOfRemaining, LEVEL_TEXT } from '@utils/common'
import { auth, loadAuth, logout } from '@renderer/stores/auth'
import { proxyStatus } from '@renderer/stores/proxy'
import {
  caInfo,
  installCa as installCaCert,
  refreshCa,
  uninstallCa as uninstallCaCert
} from '@renderer/stores/ca'
import { ui } from '@renderer/stores/ui'
import LoginDialog from './LoginDialog.vue'
import SettingsIcon from './SettingsIcon.vue'
import RulesPanel from './RulesPanel.vue'

/**
 * 设置弹窗。
 *
 * 参考 WorkBuddy 的设置：左栏「分组导航 + 搜索」，右栏「分组标题 + 白卡片行」，
 * 每行左标题右控件。原来的长滚动页面拆成八栏，一屏只放一类东西。
 *
 * 数据都还在同一个组件里：采集状态、凭证、日志本来就要实时更新，
 * 拆成子组件反而要来回传 props。栏目的切换只是 v-if。
 */

// ---- 导航 ----
const NAV = [
  {
    group: '设置',
    items: [
      { key: 'general', label: '通用', icon: 'sliders', keywords: '端口 自启 托盘 启动 采集' },
      { key: 'account', label: '账号', icon: 'user', keywords: '登录 退出 用户名 账号' }
    ]
  },
  {
    group: '功能',
    items: [
      { key: 'status', label: '运行状态', icon: 'pulse', keywords: '采集 解密 直通 代理 指标' },
      { key: 'rules', label: '抓包规则', icon: 'route', keywords: '域名 解密 直通 白名单 host' },
      { key: 'credentials', label: '凭证库', icon: 'card', keywords: 'token 复制 有效期 清除' },
      { key: 'reporter', label: '凭证上报', icon: 'upload', keywords: '云端 地址 密钥 间隔' },
      { key: 'logs', label: '运行日志', icon: 'list', keywords: '请求 抓包 记录 报错' }
    ]
  },
  {
    group: '数据与安全',
    items: [
      { key: 'ca', label: '根证书', icon: 'shield', keywords: 'https 解密 安装 卸载 指纹' },
      { key: 'about', label: '关于', icon: 'info', keywords: '版本 设备 数据目录' }
    ]
  }
]

const visible = computed({
  get: () => ui.settingsOpen,
  set: (v) => {
    ui.settingsOpen = v
  }
})

const active = ref(ui.settingsSection)
const keyword = ref('')

const filteredNav = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return NAV
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((it) => `${it.label} ${it.keywords || ''}`.toLowerCase().includes(kw))
  })).filter((g) => g.items.length)
})

/** 后台只下发 user / admin 两种角色，展示成中文 */
const roleText = computed(() => {
  const r = String(auth.member?.role || '').toLowerCase()
  if (r === 'admin') return '管理员'
  if (r === 'user') return '普通用户'
  return r || '账号'
})

// ---- 配置项 ----
const reporter = reactive({ enabled: false, url: '', token: '', minIntervalSec: 30 })
const appCfg = reactive({ autoLaunch: false, minimizeToTray: true })
const proxyCfg = reactive({ port: 9090, autoStart: false })
const appInfo = reactive({ version: '', platform: '', agentId: '', dataDir: '' })

const testing = ref(false)
const installing = ref(false)
const loginOpen = ref(false)

// ---- 凭证 ----
const credentials = ref([])
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

async function loadCredentials() {
  try {
    credentials.value = (await invoke('credentials:list')) || []
  } catch (e) {
    ElMessage.error(`读取凭证失败：${e.message}`)
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
  await loadCredentials()
}

// ---- 日志 ----
const activeTab = ref('captures')
const captures = ref([])
const logs = ref([])
let offCapture = null
let offLog = null

const activeCount = computed(() =>
  activeTab.value === 'captures' ? captures.value.length : logs.value.length
)

async function loadLogs() {
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

function levelTagClass(level) {
  return `lv-${level || 'info'}`
}

// ---- 配置读写 ----
async function load() {
  const cfg = await invoke('config:get')
  Object.assign(reporter, cfg.reporter || {})
  Object.assign(appCfg, cfg.app || {})
  Object.assign(proxyCfg, cfg.proxy || {})

  // 证书状态统一走 store：状态栏读的是同一份，装/卸后两边一起变
  await refreshCa()

  const info = await invoke('app:info')
  Object.assign(appInfo, info || {})
}

async function saveReporter() {
  await invoke('config:update', {
    reporter: {
      enabled: reporter.enabled,
      url: reporter.url,
      token: reporter.token,
      minIntervalSec: Number(reporter.minIntervalSec) || 30
    }
  })
  ElMessage.success('上报配置已保存')
}

async function testReporter() {
  testing.value = true
  try {
    await saveReporter()
    const res = await invoke('reporter:test')
    if (res?.ok) ElMessage.success(`连接成功（${res.message}）`)
    else ElMessage.error(`连接失败：${res?.message || '未知错误'}`)
  } finally {
    testing.value = false
  }
}

async function saveApp() {
  await invoke('config:update', {
    app: {
      autoLaunch: appCfg.autoLaunch,
      minimizeToTray: appCfg.minimizeToTray
    }
  })
  await invoke('autolaunch:set', { enabled: appCfg.autoLaunch })
  ElMessage.success('已保存')
}

async function saveProxy() {
  await invoke('config:update', {
    proxy: {
      port: Number(proxyCfg.port) || 9090,
      autoStart: proxyCfg.autoStart
    }
  })
  ElMessage.success('已保存，下次启动采集时生效')
}

async function installCa() {
  installing.value = true
  try {
    const res = await installCaCert()
    if (res?.ok) ElMessage.success('根证书已安装')
    else ElMessage.error(res?.message || '安装失败')
  } finally {
    installing.value = false
  }
}

async function exportCa() {
  const res = await invoke('ca:export')
  if (res?.ok) ElMessage.success(`已导出到 ${res.path}`)
}

async function removeCa() {
  const res = await uninstallCaCert()
  if (res?.ok) ElMessage.success(res.message || '已卸载根证书')
  else ElMessage.error(res?.message || '卸载失败')
}

async function openDataDir() {
  await invoke('app:open-data-dir')
}

async function doLogout() {
  try {
    await logout()
    ElMessage.success('已退出登录')
  } catch (e) {
    ElMessage.error(e.message || '退出失败')
  }
}

function goto(key) {
  active.value = key
}

// 每次打开都重新拉一遍：配置可能在别处被改过，凭证和日志更是随时在变
watch(visible, (open) => {
  if (!open) return
  active.value = ui.settingsSection
  keyword.value = ''
  load()
  loadCredentials()
  loadLogs()
})

// 用户点了导航就把位置记回 store，下次打开停在这一栏
watch(active, (v) => {
  ui.settingsSection = v
})

// 弹窗已经开着时，外部再指定栏目（比如状态栏点「证书」）也要跟着切
watch(
  () => ui.settingsSection,
  (v) => {
    if (ui.settingsOpen && v !== active.value) active.value = v
  }
)

/**
 * 搜索时左侧只剩命中的几项。如果当前栏目被过滤掉了，
 * 右栏还停在一个「列表里看不见的」页面上会很怪，所以直接跳到第一个命中项。
 */
watch(filteredNav, (groups) => {
  if (!keyword.value.trim()) return
  const keys = groups.flatMap((g) => g.items.map((it) => it.key))
  if (keys.length && !keys.includes(active.value)) active.value = keys[0]
})

onMounted(async () => {
  loadAuth()
  load()
  await loadCredentials()
  await loadLogs()

  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 10000)
  offCredential = on('credential-updated', () => loadCredentials())

  // 弹窗关着也照收，打开时列表已经是热的
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
  if (tickTimer) clearInterval(tickTimer)
  if (offCredential) offCredential()
  if (offCapture) offCapture()
  if (offLog) offLog()
})
</script>

<template>
  <el-dialog
    v-model="visible"
    class="settings-dlg"
    width="960px"
    align-center
    append-to-body
    :close-on-click-modal="false"
  >
    <template #header>
      <span class="dlg-title">设置</span>
    </template>

    <div class="dlg-body">
      <!-- 左栏：搜索 + 分组导航 -->
      <aside class="nav">
        <div class="nav-search">
          <el-input v-model="keyword" size="small" placeholder="搜索设置项" clearable>
            <template #prefix>
              <SettingsIcon name="search" class="search-ico" />
            </template>
          </el-input>
        </div>

        <div class="nav-scroll">
          <template v-for="g in filteredNav" :key="g.group">
            <div class="nav-group">{{ g.group }}</div>
            <button
              v-for="it in g.items"
              :key="it.key"
              class="nav-item"
              :class="{ active: active === it.key }"
              @click="active = it.key"
            >
              <SettingsIcon :name="it.icon" />
              <span class="nav-label">{{ it.label }}</span>
            </button>
          </template>

          <div v-if="!filteredNav.length" class="nav-empty">没有匹配的设置项</div>
        </div>
      </aside>

      <!-- 右栏：内容 -->
      <section class="panel">
        <!-- ========== 通用 ========== -->
        <template v-if="active === 'general'">
          <div class="grp">启动与运行</div>
          <div class="card">
            <div class="row">
              <div class="row-main">
                <div class="row-title">启动时自动采集</div>
                <div class="row-desc">软件启动后立即接管系统代理</div>
              </div>
              <el-switch v-model="proxyCfg.autoStart" size="small" @change="saveProxy" />
            </div>

            <div class="row">
              <div class="row-main">
                <div class="row-title">开机自启动</div>
                <div class="row-desc">随系统登录自动运行</div>
              </div>
              <el-switch v-model="appCfg.autoLaunch" size="small" @change="saveApp" />
            </div>

            <div class="row">
              <div class="row-main">
                <div class="row-title">关闭窗口后驻留托盘</div>
                <div class="row-desc">关闭面板不退出程序，采集继续在后台运行</div>
              </div>
              <el-switch v-model="appCfg.minimizeToTray" size="small" @change="saveApp" />
            </div>
          </div>

          <div class="grp">采集</div>
          <div class="card">
            <div class="row">
              <div class="row-main">
                <div class="row-title">监听端口</div>
                <div class="row-desc">被占用时会自动切换，无需手动处理；改动在下次启动采集时生效</div>
              </div>
              <el-input-number
                v-model="proxyCfg.port"
                class="ctl-num"
                size="small"
                :min="1024"
                :max="65535"
                :controls="false"
                @change="saveProxy"
              />
            </div>
          </div>
        </template>

        <!-- ========== 账号 ========== -->
        <template v-else-if="active === 'account'">
          <div class="grp">登录账号</div>
          <div class="card">
            <template v-if="auth.loggedIn">
              <div class="row">
                <div class="row-main">
                  <div class="row-title">
                    {{ auth.member.name || '（未设置用户名）' }}
                    <span class="pill">{{ roleText }}</span>
                  </div>
                  <div class="row-desc">凭证归属该登录账号，一台设备同时只登录一个</div>
                </div>
                <span class="val mono">{{ auth.member.username || auth.member.phone }}</span>
              </div>

              <div class="row">
                <div class="row-main">
                  <div class="row-title">接口地址</div>
                  <div class="row-desc">内置地址，由客户端固定，无需配置</div>
                </div>
                <span class="val mono ellipsis" :title="auth.baseUrl">{{ auth.baseUrl }}</span>
              </div>

              <div class="row">
                <div class="row-main">
                  <div class="row-title">数据权限</div>
                  <div class="row-desc">由后台按账号下发，改了权限重开一次设置即可看到</div>
                </div>
                <div class="row-ctl">
                  <span class="pill" :class="auth.permissions.logs ? 'ok' : ''">日志</span>
                  <span class="pill" :class="auth.permissions.orderPool ? 'ok' : ''">订单池</span>
                  <span class="pill" :class="auth.permissions.releases ? 'ok' : ''">放行</span>
                </div>
              </div>
            </template>

            <div v-else class="row">
              <div class="row-main">
                <div class="row-title">未登录</div>
                <div class="row-desc">用后台账号登录，采集结果才会归属到你的账号</div>
              </div>
              <el-button size="small" type="primary" @click="loginOpen = true">登录</el-button>
            </div>
          </div>

          <div v-if="auth.loggedIn" class="acts">
            <el-button size="small" @click="loginOpen = true">切换账号</el-button>
            <el-button size="small" @click="doLogout">退出登录</el-button>
          </div>
        </template>

        <!-- ========== 运行状态 ========== -->
        <template v-else-if="active === 'status'">
          <div class="grp">采集状态</div>
          <div class="card">
            <div class="state">
              <div class="state-main">
                <span class="led" :class="{ on: proxyStatus.running }"></span>
                <div class="state-text">
                  <div class="state-title">
                    {{ proxyStatus.running ? '正在采集' : '采集未启动' }}
                  </div>
                  <div class="state-desc">
                    <template v-if="proxyStatus.running">
                      系统代理指向 127.0.0.1:{{ proxyStatus.port }}，只解密白名单域名
                    </template>
                    <template v-else>用标题栏的播放按钮启动，停止或退出时自动还原</template>
                  </div>
                </div>
              </div>

              <div class="metrics">
                <div class="metric">
                  <div class="v">{{ proxyStatus.stats?.intercepted ?? 0 }}</div>
                  <div class="k">已解密</div>
                </div>
                <div class="metric">
                  <div class="v">{{ proxyStatus.stats?.tunneled ?? 0 }}</div>
                  <div class="k">直通</div>
                </div>
                <div class="metric">
                  <div class="v">{{ credentials.length }}</div>
                  <div class="k">凭证</div>
                </div>
              </div>
            </div>

            <div v-if="!caInfo.installed" class="row tip-row">
              <div class="row-main">
                <div class="row-title warn-text">根证书未安装</div>
                <div class="row-desc">抓到的 HTTPS 内容无法解密，也就采不到请求头里的 token</div>
              </div>
              <el-button size="small" type="primary" @click="goto('ca')">去安装</el-button>
            </div>
          </div>
        </template>

        <!-- ========== 抓包规则 ========== -->
        <template v-else-if="active === 'rules'">
          <RulesPanel />
        </template>

        <!-- ========== 凭证库 ========== -->
        <template v-else-if="active === 'credentials'">
          <div class="grp">已采集 {{ credentials.length }} 条 · 按剩余有效期排序</div>

          <div v-if="!sortedCredentials.length" class="card">
            <div class="empty">
              还没有采集到凭证。到影城账号页打开参数弹窗，在微信里正常打开一次该影城的小程序。
            </div>
          </div>

          <div v-else class="card">
            <div v-for="row in sortedCredentials" :key="row.ruleId" class="cred">
              <div class="cred-main">
                <div class="cred-title">
                  <span class="cred-name">{{ row.taskName }}</span>
                  <span class="pill" :class="levelClass(row)">
                    {{ row.expiresAt ? remainingText(row) : LEVEL_TEXT[levelOf(row)] }}
                  </span>
                </div>
                <div class="cred-sub mono">
                  <span>{{ row.account || '未识别账号' }}</span>
                  <span class="sep">/</span>
                  <span class="cred-tok">{{ row.tokenMasked }}</span>
                </div>
                <div v-if="row.extraKeys?.length" class="cred-extra mono">
                  {{ row.extraKeys.map((k) => `${k}=${row.extrasMasked?.[k] || ''}`).join('  ') }}
                </div>
              </div>

              <div class="cred-side">
                <div class="cred-time">{{ formatDateTime(row.updatedAt) }}</div>
                <div class="cred-ops">
                  <el-button size="small" @click="copyToken(row)">复制</el-button>
                  <el-button size="small" text @click="removeCredential(row)">清除</el-button>
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- ========== 凭证上报 ========== -->
        <template v-else-if="active === 'reporter'">
          <div class="grp">云端上报</div>
          <div class="card">
            <div class="row">
              <div class="row-main">
                <div class="row-title">启用上报</div>
                <div class="row-desc">采集到新凭证时推送到云端；关闭时软件纯本地工作</div>
              </div>
              <el-switch v-model="reporter.enabled" size="small" @change="saveReporter" />
            </div>

            <div class="row">
              <div class="row-main">
                <div class="row-title">上报地址</div>
                <div class="row-desc">接收 POST JSON 的接口地址</div>
              </div>
              <el-input
                v-model="reporter.url"
                size="small"
                placeholder="https://your-server.com/api/agent/credential"
                class="ctl-wide"
              />
            </div>

            <div class="row">
              <div class="row-main">
                <div class="row-title">上报密钥</div>
                <div class="row-desc">随请求以 x-agent-token 头发送</div>
              </div>
              <el-input
                v-model="reporter.token"
                size="small"
                type="password"
                show-password
                class="ctl-wide"
              />
            </div>

            <div class="row">
              <div class="row-main">
                <div class="row-title">最小上报间隔</div>
                <div class="row-desc">同一系统在间隔内只上报一次，避免刷屏</div>
              </div>
              <el-input-number
                v-model="reporter.minIntervalSec"
                class="ctl-num"
                size="small"
                :min="5"
                :max="3600"
                :controls="false"
              />
            </div>
          </div>

          <div class="acts">
            <el-button size="small" type="primary" @click="saveReporter">保存</el-button>
            <el-button size="small" :loading="testing" @click="testReporter">测试连接</el-button>
          </div>
        </template>

        <!-- ========== 运行日志 ========== -->
        <template v-else-if="active === 'logs'">
          <div class="tabs">
            <button
              class="tab"
              :class="{ active: activeTab === 'captures' }"
              @click="activeTab = 'captures'"
            >
              请求记录
              <span class="count">{{ captures.length }}</span>
            </button>
            <button
              class="tab"
              :class="{ active: activeTab === 'logs' }"
              @click="activeTab = 'logs'"
            >
              运行日志
              <span class="count">{{ logs.length }}</span>
            </button>
            <span class="spacer"></span>
            <el-button v-if="activeCount" size="small" text @click="clearActive">清空</el-button>
          </div>

          <div v-if="activeTab === 'captures'">
            <div v-if="!captures.length" class="card">
              <div class="empty">
                暂无请求。启动采集并在微信里打开小程序后，这里会出现被解密的请求。
              </div>
            </div>
            <div v-else class="card log-box">
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
          </div>

          <div v-else>
            <div v-if="!logs.length" class="card">
              <div class="empty">暂无日志。</div>
            </div>
            <div v-else class="card log-box">
              <div v-for="(item, idx) in logs.slice().reverse()" :key="idx" class="log-row">
                <span class="log-time mono">{{ formatDateTime(item.at) }}</span>
                <span class="log-level mono" :class="levelTagClass(item.level)">
                  {{ item.level }}
                </span>
                <span class="log-msg">{{ item.message }}</span>
              </div>
            </div>
          </div>

          <p class="foot-note">只记录命中白名单域名的请求，直通流量不在这里出现。</p>
        </template>

        <!-- ========== 根证书 ========== -->
        <template v-else-if="active === 'ca'">
          <div class="grp">HTTPS 解密</div>
          <div class="card">
            <div class="row">
              <div class="row-main">
                <div class="row-title">
                  根证书
                  <span class="pill" :class="caInfo.installed ? 'ok' : 'warn'">
                    {{ caInfo.installed ? '已安装' : '未安装' }}
                  </span>
                </div>
                <div class="row-desc">
                  证书装在当前用户的受信任根里，不影响其他用户，卸载后立即失效
                </div>
              </div>
              <div class="row-ctl">
                <el-button
                  v-if="!caInfo.installed"
                  size="small"
                  type="primary"
                  :loading="installing"
                  @click="installCa"
                >
                  安装
                </el-button>
                <el-button v-else size="small" @click="removeCa">卸载</el-button>
                <el-button size="small" @click="exportCa">导出</el-button>
              </div>
            </div>

            <div class="row">
              <div class="row-main">
                <div class="row-title">证书指纹</div>
                <div class="row-desc mono fingerprint">{{ caInfo.fingerprint || '—' }}</div>
              </div>
            </div>
          </div>

          <p v-if="!caInfo.installed" class="foot-note warn-text">
            未安装时经过采集的 HTTPS 请求只能看到域名，看不到请求头里的凭证。
          </p>
        </template>

        <!-- ========== 关于 ========== -->
        <template v-else-if="active === 'about'">
          <div class="grp">本机</div>
          <div class="card">
            <div class="row">
              <div class="row-main">
                <div class="row-title">版本</div>
                <div class="row-desc">{{ appInfo.platform }}</div>
              </div>
              <span class="val mono">{{ appInfo.version }}</span>
            </div>

            <div class="row">
              <div class="row-main">
                <div class="row-title">设备标识</div>
                <div class="row-desc">用于在云端区分是哪台采集机</div>
              </div>
              <span class="val mono">{{ appInfo.agentId }}</span>
            </div>

            <div class="row">
              <div class="row-main">
                <div class="row-title">数据目录</div>
                <div class="row-desc mono ellipsis" :title="appInfo.dataDir">
                  {{ appInfo.dataDir }}
                </div>
              </div>
              <el-button size="small" @click="openDataDir">打开</el-button>
            </div>
          </div>
        </template>

        <div v-else class="empty-panel">从左侧选一项</div>
      </section>
    </div>

    <LoginDialog v-model="loginOpen" />
  </el-dialog>
</template>

<style lang="scss" scoped>
/* ---- 左栏 ---- */
.nav {
  width: 208px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line-soft);
  min-height: 0;
}

.nav-search {
  padding: 12px 12px 6px;
  flex-shrink: 0;
}

.nav-search :deep(.el-input__wrapper) {
  background: var(--bg-hover);
  box-shadow: none;
  border-radius: 8px;
}

.nav-search :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px var(--line-strong) inset;
  background: var(--bg);
}

.search-ico {
  color: var(--tx-4);
}

.nav-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 10px 12px;
}

.nav-group {
  padding: 14px 8px 6px;
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--tx-4);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 34px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--tx-2);
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--tx);
}

.nav-item.active {
  background: var(--bg-active);
  border-color: var(--line-strong);
  color: var(--tx);
  font-weight: 500;
}

.nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-empty {
  padding: 18px 8px;
  font-size: 11.5px;
  color: var(--tx-4);
}

/* ---- 右栏 ---- */
.panel {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  background: var(--bg-panel);
  padding: 12px 16px 18px;
}

.grp {
  padding: 2px 2px 7px;
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--tx-4);
}

.grp + .card {
  margin-bottom: 6px;
}

.card {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  overflow: hidden;
  margin-bottom: 10px;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 22px;
  padding: 13px 14px;
}

.row + .row {
  border-top: 1px solid var(--line-soft);
}

.row-main {
  min-width: 0;
}

.row-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--tx);
}

.row-desc {
  margin-top: 3px;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--tx-3);
}

.row-ctl {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.tip-row {
  border-top: 1px solid var(--line-soft);
  background: var(--warn-bg);
}

.warn-text {
  color: var(--warn);
}

.acts {
  display: flex;
  gap: 6px;
  padding: 2px 2px 0;
}

.val {
  flex-shrink: 0;
  max-width: 340px;
  font-size: 12px;
  color: var(--tx-2);
}

.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ctl-wide {
  width: 280px;
  flex-shrink: 0;
}

.ctl-num {
  width: 104px;
  flex-shrink: 0;
}

.ctl-num :deep(.el-input__inner) {
  text-align: left;
}

.fingerprint {
  word-break: break-all;
  font-size: 11px;
}

.foot-note {
  margin: 0 2px 10px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--tx-4);
}

.empty {
  padding: 22px 16px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--tx-3);
}

.empty-panel {
  padding: 30px;
  font-size: 12px;
  color: var(--tx-4);
}

/* ---- 运行状态卡 ---- */
.state {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 14px;
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
  font-size: 13px;
  font-weight: 600;
  color: var(--tx);
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
  padding: 0 16px;
  text-align: right;
  border-left: 1px solid var(--line-soft);
}

.metric:first-child {
  border-left: none;
}

.metric .v {
  font-size: 17px;
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

/* ---- 凭证 ---- */
.cred {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 12px 14px;
  transition: background 0.12s ease;
}

.cred + .cred {
  border-top: 1px solid var(--line-soft);
}

.cred:hover {
  background: var(--bg-hover);
}

.cred-main {
  min-width: 0;
}

.cred-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cred-name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--tx);
}

.cred-sub {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11.5px;
  color: var(--tx-3);
}

.cred-sub .sep {
  color: var(--tx-4);
}

.cred-tok {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cred-extra {
  margin-top: 3px;
  font-size: 11px;
  color: var(--tx-3);
}

.cred-side {
  display: flex;
  align-items: center;
  gap: 12px;
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

/* ---- 日志 ---- */
.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-bottom: 8px;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: none;
  border-radius: 6px;
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

/* 日志会一直涨，卡片内部自己滚，别把弹窗撑长 */
.log-box {
  max-height: 372px;
  overflow-y: auto;
}

.tr {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 30px;
  padding: 0 14px;
  font-size: 11.5px;
}

.tr.th {
  height: 28px;
  font-size: 11px;
  color: var(--tx-4);
  position: sticky;
  top: 0;
  background: var(--bg);
  z-index: 1;
}

.tr:not(.th):hover {
  background: var(--bg-hover);
}

.c-time {
  width: 58px;
  flex-shrink: 0;
  color: var(--tx-4);
}

.c-method {
  width: 40px;
  flex-shrink: 0;
  color: var(--tx-3);
}

.c-host {
  width: 168px;
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
  width: 38px;
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
  width: 50px;
  flex-shrink: 0;
  text-align: right;
  color: var(--tx-4);
}

.log-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 5px 14px;
  font-size: 11.5px;
}

.log-row:hover {
  background: var(--bg-hover);
}

.log-time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--tx-4);
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

<style lang="scss">
/* 弹窗本体：去掉 Element 默认内边距，头和身子自己排 */
.settings-dlg {
  padding: 0;
  overflow: hidden;
}

.settings-dlg .el-dialog__header {
  margin: 0;
  padding: 13px 16px 12px;
  border-bottom: 1px solid var(--line-soft);
}

.settings-dlg .el-dialog__headerbtn {
  top: 8px;
  right: 8px;
}

.settings-dlg .el-dialog__title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--tx);
}

.settings-dlg .el-dialog__body {
  padding: 0;
}
</style>

<style lang="scss" scoped>
.dlg-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--tx);
}

.dlg-body {
  display: flex;
  height: 560px;
  /* 窗口最小高度 600 时也要留出上下边距，别把弹窗顶穿 */
  max-height: calc(100vh - 132px);
  min-height: 0;
}
</style>
