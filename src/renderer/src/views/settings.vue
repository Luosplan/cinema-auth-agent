<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { invoke } from '@utils/ipc'
import { formatDateTime } from '@utils/common'

const reporter = reactive({ enabled: false, url: '', token: '', minIntervalSec: 30 })
const appCfg = reactive({ autoLaunch: false, minimizeToTray: true })
const proxyCfg = reactive({ port: 9090, autoStart: false })
const caInfo = reactive({ installed: false, fingerprint: '', notAfter: null })
const appInfo = reactive({ version: '', platform: '', agentId: '', dataDir: '' })

const testing = ref(false)
const installing = ref(false)
const savingPort = ref(false)

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
  savingPort.value = true
  try {
    await invoke('config:update', {
      proxy: {
        port: Number(proxyCfg.port) || 9090,
        autoStart: proxyCfg.autoStart
      }
    })
    ElMessage.success('已保存，下次启动采集时生效')
  } finally {
    savingPort.value = false
  }
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

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h2>设置</h2>
      <p>采集默认只在本机生效。开启上报后，凭证才会发送到你配置的云端地址。</p>
    </div>

    <section class="block">
      <div class="block-title">凭证上报</div>

      <div class="row">
        <div class="row-main">
          <div class="row-label">启用上报</div>
          <div class="row-desc">关闭时软件纯本地工作，不向任何地址发送数据</div>
        </div>
        <el-switch v-model="reporter.enabled" @change="saveReporter" />
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
          style="width: 380px"
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
          style="width: 380px"
        />
      </div>

      <div class="row">
        <div class="row-main">
          <div class="row-label">最小上报间隔</div>
          <div class="row-desc">同一系统在间隔内只上报一次，避免刷屏</div>
        </div>
        <el-input-number v-model="reporter.minIntervalSec" :min="5" :max="3600" size="small" />
      </div>

      <div class="actions">
        <el-button size="small" type="primary" @click="saveReporter">保存</el-button>
        <el-button size="small" :loading="testing" @click="testReporter">测试连接</el-button>
      </div>
    </section>

    <section class="block">
      <div class="block-title">采集设置</div>

      <div class="row">
        <div class="row-main">
          <div class="row-label">启动时自动采集</div>
          <div class="row-desc">软件启动后立即接管系统代理</div>
        </div>
        <el-switch v-model="proxyCfg.autoStart" @change="saveProxy" />
      </div>

      <div class="row">
        <div class="row-main">
          <div class="row-label">监听端口</div>
          <div class="row-desc">被占用时会自动切换，无需手动处理</div>
        </div>
        <el-input-number v-model="proxyCfg.port" :min="1024" :max="65535" size="small" />
      </div>

      <div class="row">
        <div class="row-main">
          <div class="row-label">开机自启</div>
          <div class="row-desc">随系统登录自动运行</div>
        </div>
        <el-switch v-model="appCfg.autoLaunch" @change="saveApp" />
      </div>

      <div class="row">
        <div class="row-main">
          <div class="row-label">关闭窗口后驻留托盘</div>
          <div class="row-desc">关闭面板不退出程序，采集继续在后台运行</div>
        </div>
        <el-switch v-model="appCfg.minimizeToTray" @change="saveApp" />
      </div>
    </section>

    <section class="block">
      <div class="block-title">根证书</div>

      <div class="row">
        <div class="row-main">
          <div class="row-label">
            安装状态
            <el-tag size="small" :type="caInfo.installed ? 'success' : 'danger'" effect="light">
              {{ caInfo.installed ? '已安装' : '未安装' }}
            </el-tag>
          </div>
          <div class="row-desc">
            证书指纹 <span class="mono">{{ caInfo.fingerprint }}</span>
          </div>
        </div>
        <div class="actions-inline">
          <el-button v-if="!caInfo.installed" size="small" type="primary" :loading="installing" @click="installCa">
            安装
          </el-button>
          <el-button v-else size="small" @click="removeCa">卸载</el-button>
          <el-button size="small" @click="exportCa">导出</el-button>
        </div>
      </div>

      <div class="hint">
        根证书只用于解密本机流量。它被装在你的用户证书库中，不会影响其他用户，
        卸载后即完全失效。
      </div>
    </section>

    <section class="block">
      <div class="block-title">关于</div>

      <div class="row">
        <div class="row-main">
          <div class="row-label">版本</div>
          <div class="row-desc">{{ appInfo.version }} · {{ appInfo.platform }}</div>
        </div>
      </div>

      <div class="row">
        <div class="row-main">
          <div class="row-label">设备标识</div>
          <div class="row-desc mono">{{ appInfo.agentId }}</div>
        </div>
      </div>

      <div class="row">
        <div class="row-main">
          <div class="row-label">数据目录</div>
          <div class="row-desc mono">{{ appInfo.dataDir }}</div>
        </div>
        <el-button size="small" @click="openDataDir">打开</el-button>
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

.page-head h2 {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 500;
  color: #1b2330;
}

.page-head p {
  margin: 0 0 16px;
  font-size: 12px;
  color: #8b94a4;
  line-height: 1.8;
}

.block {
  background: #fff;
  border: 1px solid #e8eaf0;
  border-radius: 10px;
  padding: 6px 18px 14px;
  margin-bottom: 14px;
}

.block-title {
  font-size: 13px;
  font-weight: 500;
  color: #1b2330;
  padding: 13px 0 10px;
  border-bottom: 1px solid #f2f4f8;
  margin-bottom: 4px;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 11px 0;
  border-bottom: 1px solid #f7f8fb;
}

.row:last-child {
  border-bottom: none;
}

.row-main {
  min-width: 0;
}

.row-label {
  font-size: 13px;
  color: #3d4657;
  display: flex;
  align-items: center;
  gap: 8px;
}

.row-desc {
  font-size: 11px;
  color: #9aa3b2;
  margin-top: 3px;
  line-height: 1.6;
}

.mono {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  word-break: break-all;
}

.actions {
  display: flex;
  gap: 8px;
  padding-top: 12px;
}

.actions-inline {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.hint {
  font-size: 11px;
  color: #9aa3b2;
  line-height: 1.8;
  padding-bottom: 4px;
}
</style>
