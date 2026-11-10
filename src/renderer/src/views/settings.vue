<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { invoke } from '@utils/ipc'
import { auth, loadAuth, logout } from '../stores/auth'
import LoginDialog from '../components/LoginDialog.vue'

const reporter = reactive({ enabled: false, url: '', token: '', minIntervalSec: 30 })
const appCfg = reactive({ autoLaunch: false, minimizeToTray: true })
const proxyCfg = reactive({ port: 9090, autoStart: false })
const caInfo = reactive({ installed: false, fingerprint: '', notAfter: null })
const appInfo = reactive({ version: '', platform: '', agentId: '', dataDir: '' })

const testing = ref(false)
const installing = ref(false)
const loginOpen = ref(false)

async function load() {
  const cfg = await invoke('config:get')
  Object.assign(reporter, cfg.reporter || {})
  Object.assign(appCfg, cfg.app || {})
  Object.assign(proxyCfg, cfg.proxy || {})

  const ca = await invoke('ca:info')
  Object.assign(caInfo, ca || {})

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
    const res = await invoke('ca:install')
    if (res?.ok) ElMessage.success('根证书已安装')
    else ElMessage.error(res?.message || '安装失败')
    await load()
  } finally {
    installing.value = false
  }
}

async function exportCa() {
  const res = await invoke('ca:export')
  if (res?.ok) ElMessage.success(`已导出到 ${res.path}`)
}

async function removeCa() {
  const res = await invoke('ca:uninstall')
  if (res?.ok) {
    ElMessage.success('已卸载根证书')
    await load()
  } else {
    ElMessage.error(res?.message || '卸载失败')
  }
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

onMounted(() => {
  load()
  loadAuth()
})
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <div class="page-head">
        <div>
          <h1 class="page-title">设置</h1>
          <p class="page-desc">
            采集默认只在本机生效。开启上报后，凭证才会发送到你配置的云端地址。
          </p>
        </div>
      </div>

      <!-- 账号 -->
      <section class="section first">
        <div class="section-head">
          <h2 class="section-title">账号</h2>
          <span class="section-hint">凭证归属该会员账号，一台设备同时只登录一个</span>
        </div>

        <template v-if="auth.loggedIn">
          <div class="row">
            <div class="row-main">
              <div class="row-label">会员</div>
              <div class="row-desc">{{ auth.member.name || '（未设置昵称）' }}</div>
            </div>
            <span class="val mono">{{ auth.member.phone }}</span>
          </div>

          <div class="row">
            <div class="row-main">
              <div class="row-label">接口地址</div>
              <div class="row-desc">内置地址，与会员端同一套服务，无需配置</div>
            </div>
            <span class="val mono ellipsis" :title="auth.baseUrl">{{ auth.baseUrl }}</span>
          </div>

          <div class="row-actions">
            <el-button size="small" @click="loginOpen = true">切换账号</el-button>
            <el-button size="small" @click="doLogout">退出登录</el-button>
          </div>
        </template>

        <div v-else class="row">
          <div class="row-main">
            <div class="row-label">未登录</div>
            <div class="row-desc">用会员手机号登录，采集结果才会归属到你的账号</div>
          </div>
          <el-button size="small" type="primary" @click="loginOpen = true">登录</el-button>
        </div>
      </section>

      <!-- 凭证上报 -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">凭证上报</h2>
          <span class="section-hint">关闭时软件纯本地工作，不向任何地址发送数据</span>
        </div>

        <div class="row">
          <div class="row-main">
            <div class="row-label">启用上报</div>
            <div class="row-desc">采集到新凭证时推送到云端</div>
          </div>
          <el-switch v-model="reporter.enabled" size="small" @change="saveReporter" />
        </div>

        <div class="row">
          <div class="row-main">
            <div class="row-label">上报地址</div>
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
            <div class="row-label">上报密钥</div>
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
            <div class="row-label">最小上报间隔</div>
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

        <div class="row-actions">
          <el-button size="small" type="primary" @click="saveReporter">保存</el-button>
          <el-button size="small" :loading="testing" @click="testReporter">测试连接</el-button>
        </div>
      </section>

      <!-- 采集设置 -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">采集</h2>
        </div>

        <div class="row">
          <div class="row-main">
            <div class="row-label">启动时自动采集</div>
            <div class="row-desc">软件启动后立即接管系统代理</div>
          </div>
          <el-switch v-model="proxyCfg.autoStart" size="small" @change="saveProxy" />
        </div>

        <div class="row">
          <div class="row-main">
            <div class="row-label">监听端口</div>
            <div class="row-desc">被占用时会自动切换，无需手动处理</div>
          </div>
          <el-input-number
            v-model="proxyCfg.port"
            class="ctl-num"
            size="small"
            :min="1024"
            :max="65535"
            :controls="false"
          />
        </div>

        <div class="row">
          <div class="row-main">
            <div class="row-label">开机自启</div>
            <div class="row-desc">随系统登录自动运行</div>
          </div>
          <el-switch v-model="appCfg.autoLaunch" size="small" @change="saveApp" />
        </div>

        <div class="row">
          <div class="row-main">
            <div class="row-label">关闭窗口后驻留托盘</div>
            <div class="row-desc">关闭面板不退出程序，采集继续在后台运行</div>
          </div>
          <el-switch v-model="appCfg.minimizeToTray" size="small" @change="saveApp" />
        </div>
      </section>

      <!-- 根证书 -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">根证书</h2>
          <span class="pill" :class="caInfo.installed ? 'ok' : 'warn'">
            {{ caInfo.installed ? '已安装' : '未安装' }}
          </span>
        </div>

        <div class="row">
          <div class="row-main">
            <div class="row-label">证书指纹</div>
            <div class="row-desc mono fingerprint">{{ caInfo.fingerprint || '—' }}</div>
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

        <p class="foot-note">
          证书装在当前用户的受信任根里，不影响其他用户；卸载后立即失效。
        </p>
      </section>

      <!-- 关于 -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">关于</h2>
        </div>

        <div class="kv">
          <span class="kv-k">版本</span>
          <span class="kv-v">{{ appInfo.version }} · {{ appInfo.platform }}</span>
        </div>
        <div class="kv">
          <span class="kv-k">设备标识</span>
          <span class="kv-v mono">{{ appInfo.agentId }}</span>
        </div>
        <div class="kv">
          <span class="kv-k">数据目录</span>
          <span class="kv-v mono ellipsis" :title="appInfo.dataDir">{{ appInfo.dataDir }}</span>
          <el-button size="small" text @click="openDataDir">打开</el-button>
        </div>
      </section>

      <LoginDialog v-model="loginOpen" />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.section.first {
  margin-top: 4px;
}

/* ---- 设置行 ---- */
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 11px 0;
  border-bottom: 1px solid var(--line-soft);
}

.row:last-of-type {
  border-bottom: none;
}

.row-main {
  min-width: 0;
}

.row-label {
  font-size: 12.5px;
  color: var(--tx);
}

.row-desc {
  margin-top: 2px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--tx-4);
}

.row-ctl {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.ctl-wide {
  width: 340px;
  flex-shrink: 0;
}

/* 数字输入去掉步进按钮后与文本输入同高（默认 small=26、文本=30，视觉不齐） */
.ctl-num {
  width: 104px;
  flex-shrink: 0;
}

.ctl-num :deep(.el-input__inner) {
  text-align: left;
}

.row-actions {
  display: flex;
  gap: 6px;
  padding: 12px 0 2px;
}

/* 行内按钮统一抬到与输入框同高（small 输入 26px、small 按钮 24px） */
.row-actions .el-button,
.row-ctl .el-button {
  height: 26px;
}

.fingerprint {
  word-break: break-all;
  font-size: 11px;
  letter-spacing: 0.01em;
}

.foot-note {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--tx-4);
}

/* ---- 键值行 ---- */
.kv {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 9px 0;
  border-bottom: 1px solid var(--line-soft);
  font-size: 12px;
}

.kv:last-child {
  border-bottom: none;
}

.kv-k {
  width: 64px;
  flex-shrink: 0;
  color: var(--tx-4);
}

.kv-v {
  flex: 1;
  min-width: 0;
  color: var(--tx-2);
}

.val {
  flex-shrink: 0;
  max-width: 320px;
  font-size: 12px;
  color: var(--tx-2);
}

.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
