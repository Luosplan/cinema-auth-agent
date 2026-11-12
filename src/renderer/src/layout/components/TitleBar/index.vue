<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invoke, on } from '@utils/ipc'
import { auth, avatarText, displayName, loadAuth, logout } from '@renderer/stores/auth'
import { proxyStatus, toggleProxy } from '@renderer/stores/proxy'
import { caInfo, installCa as installCaCert, refreshCa } from '@renderer/stores/ca'
import { openSettings } from '@renderer/stores/ui'
import LoginDialog from '@renderer/components/LoginDialog.vue'
import SettingsDialog from '@renderer/components/SettingsDialog.vue'

/**
 * 自绘标题栏。
 *
 * 窗口是 frame:false，系统不再画 ─ □ ✕，所以这里既是「应用的顶部导航」也是「窗口边框」：
 *   - 整条是拖动区（-webkit-app-region: drag），只有按钮要标 no-drag，否则点不动
 *   - 双击空白处最大化由系统直接处理，不用自己写
 *   - 采集开关用播放/暂停图标表示「点下去会发生什么」，状态文字交给底部状态栏
 */
const loginOpen = ref(false)
const menuOpen = ref(false)
const loggingOut = ref(false)
const maximized = ref(false)

const name = computed(() => displayName())
const initial = computed(() => avatarText())

/** 未装证书时把原因写进 tooltip，省得用户点下去才发现要先装 */
const toggleTitle = computed(() => {
  if (proxyStatus.running) return '停止采集'
  return caInfo.installed ? '开始采集' : '开始采集（需先安装根证书）'
})

let offWindowState = null

/**
 * 真正去切采集状态。抽出这一层是为了「装完证书继续启动」能复用，
 * 而不是在拦截分支里再拼一遍 toast 逻辑。错误文案交给调用方决定怎么提示。
 */
async function doToggle() {
  const res = await toggleProxy()
  if (!res) return null
  if (!res.error) ElMessage.success(res.running ? '采集已启动' : '采集已停止')
  return res
}

/**
 * 启动前的证书引导。
 *
 * 没装根证书就启动代理是纯粹的假启动：HTTPS 只能隧道直通，解不出 token；
 * 而且客户端信任链会断，小程序请求反而报错 —— 用户看到的是「采集中」，
 * 却一条凭证也拿不到。所以这里先拦一道，把「为什么必须装」讲清楚再给安装入口。
 */
async function guideInstallCa() {
  try {
    await ElMessageBox.confirm(
      '请先安装证书。',
      '需要先安装根证书',
      {
        confirmButtonText: '安装并启动',
        cancelButtonText: '取消',
        type: 'warning',
        // 弹窗挂在 body 上，别被标题栏的拖动区/固定高度影响布局
        appendTo: document.body
      }
    )
  } catch {
    // 用户点了取消或关掉，什么都不做
    return
  }

  const res = await installCaCert()
  if (res?.ok) {
    ElMessage.success('根证书已安装，正在启动采集')
    await doToggle()
    return
  }

  // 装不上（系统拒绝 / 非 Windows）就别硬启动，把人送到证书页看详情
  ElMessage.error(res?.message || '根证书安装失败，请到「数据与安全 → 根证书」手动处理')
  openSettings('ca')
}

async function onToggleProxy() {
  if (proxyStatus.busy) return

  /**
   * 已知没装证书：直接引导，不再先问一遍主进程。
   *
   * 原来这里是「点一下 → 先 refreshCa（一次 PowerShell 冷启动，400ms 上下）→ 判断 → 再启动」，
   * 相当于每次点击都白等半秒。证书装/卸都会刷新状态，窗口重新获得焦点时也会复核，
   * 缓存足够新；真过期了，主进程那道闸会返回错误，下面照样能把人引导过去。
   */
  if (!proxyStatus.running && caInfo.loaded && !caInfo.installed) {
    await guideInstallCa()
    return
  }

  const res = await doToggle()
  if (!res?.error) return

  // 主进程说证书没装，说明界面状态过期了：复核后引导安装，别只甩一行红字
  if (/根证书/.test(res.error)) {
    await refreshCa()
    await guideInstallCa()
    return
  }

  ElMessage.error(res.error)
}

async function onMinimize() {
  await invoke('window:minimize')
}

async function onToggleMax() {
  const res = await invoke('window:toggle-max')
  maximized.value = Boolean(res?.maximized)
}

async function onClose() {
  await invoke('window:close')
}

function onAccountClick() {
  if (!auth.loggedIn) {
    loginOpen.value = true
    return
  }
  menuOpen.value = !menuOpen.value
}

function openLogin() {
  menuOpen.value = false
  loginOpen.value = true
}

async function doLogout() {
  menuOpen.value = false
  loggingOut.value = true
  try {
    await logout()
    ElMessage.success('已退出登录')
  } catch (e) {
    ElMessage.error(e.message || '退出失败')
  } finally {
    loggingOut.value = false
  }
}

function onDocClick(e) {
  if (!menuOpen.value) return
  if (e.target.closest?.('.account-wrap')) return
  menuOpen.value = false
}

onMounted(async () => {
  loadAuth()
  const res = await invoke('window:state').catch(() => null)
  maximized.value = Boolean(res?.maximized)
  offWindowState = on('window-state', (payload) => {
    maximized.value = Boolean(payload?.maximized)
  })
  document.addEventListener('click', onDocClick)
})

onUnmounted(() => {
  if (offWindowState) offWindowState()
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <header class="tbar">
    <div class="brand">
      <!-- 浅色底下 logo 要反过来画：深色圆角块 + 白色票根，否则白底上看不见 -->
      <svg class="logo" viewBox="0 0 24 24" aria-hidden="true">
        <rect width="24" height="24" rx="6.5" fill="#17181a" />
        <rect x="5.4" y="8.3" width="13.2" height="7.4" rx="1.5" fill="#fff" />
        <circle cx="5.4" cy="12" r="1.45" fill="#17181a" />
        <circle cx="18.6" cy="12" r="1.45" fill="#17181a" />
        <path
          d="M12 9.2v1.5M12 11.25v1.5M12 13.3v1.5"
          stroke="#17181a"
          stroke-width="1"
          stroke-linecap="round"
        />
      </svg>
      <span class="app-name">HK票务助手</span>
    </div>

    <div class="actions">
      <!-- 采集开关：图标表示下一步做什么，采集中是暂停，已停止是播放 -->
      <button
        class="icon-btn toggle"
        :class="{ busy: proxyStatus.busy }"
        :title="toggleTitle"
        :aria-label="toggleTitle"
        @click="onToggleProxy"
      >
        <svg v-if="proxyStatus.running" viewBox="0 0 24 24" class="fill">
          <rect x="6.6" y="5" width="4.2" height="14" rx="1.2" />
          <rect x="13.2" y="5" width="4.2" height="14" rx="1.2" />
        </svg>
        <svg v-else viewBox="0 0 24 24" class="fill">
          <path d="M8 5.4c0-.8.9-1.3 1.6-.9l9.3 6.6c.6.4.6 1.4 0 1.8l-9.3 6.6c-.7.4-1.6-.1-1.6-.9z" />
        </svg>
      </button>

      <button class="icon-btn" title="设置" aria-label="设置" @click="openSettings()">
        <svg viewBox="0 0 24 24">
          <path
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6"
          />
        </svg>
      </button>

      <span class="vsep"></span>

      <!-- 未登录：直接给入口，不做成隐藏菜单 -->
      <button v-if="!auth.loggedIn" class="login-btn" @click="loginOpen = true">
        登录
        <svg viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" /></svg>
      </button>

      <div v-else class="account-wrap">
        <div
          class="acct"
          :class="{ busy: loggingOut }"
          role="button"
          tabindex="0"
          @click="onAccountClick"
          @keyup.enter="onAccountClick"
        >
          <span class="avatar">{{ initial }}</span>
          <span class="acct-name">{{ name }}</span>
          <svg class="caret" :class="{ open: menuOpen }" viewBox="0 0 24 24">
            <path d="m8 10 4-4 4 4M8 14l4 4 4-4" />
          </svg>
        </div>

        <transition name="pop">
          <div v-if="menuOpen" class="menu">
            <div class="menu-head">
              <div class="menu-name">{{ name }}</div>
              <div class="menu-sub mono">{{ auth.member?.phone }}</div>
            </div>
            <button class="menu-item" @click="openLogin">切换账号</button>
            <button class="menu-item danger" @click="doLogout">退出登录</button>
          </div>
        </transition>
      </div>

      <!-- 窗口按钮：自己画，窗口是 frame:false -->
      <div class="win-ctrl">
        <button class="wc" title="最小化" aria-label="最小化" @click="onMinimize">
          <svg viewBox="0 0 10 10"><path d="M1 5h8" /></svg>
        </button>
        <button
          class="wc"
          :title="maximized ? '还原' : '最大化'"
          :aria-label="maximized ? '还原' : '最大化'"
          @click="onToggleMax"
        >
          <svg v-if="!maximized" viewBox="0 0 10 10">
            <rect x="1.5" y="1.5" width="7" height="7" />
          </svg>
          <svg v-else viewBox="0 0 10 10">
            <rect x="1.2" y="3" width="5.8" height="5.8" />
            <path d="M3 3V1.2h5.8v5.8H8" />
          </svg>
        </button>
        <button class="wc close" title="关闭" aria-label="关闭" @click="onClose">
          <svg viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" /></svg>
        </button>
      </div>
    </div>

    <LoginDialog v-model="loginOpen" />
    <SettingsDialog />
  </header>
</template>

<style lang="scss" scoped>
.tbar {
  height: 41px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding-left: 14px;
  background: var(--bg);
  /* 和内容区之间用一根线分开：浅色底下靠线，不靠底色差 */
  border-bottom: 1px solid var(--line);
  /* 整条是窗口拖动区，按钮必须标 no-drag，否则点不动 */
  -webkit-app-region: drag;
}

.tbar > *,
.actions > * {
  -webkit-app-region: no-drag;
}

/* ---- 品牌 ---- */
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logo {
  width: 20px;
  height: 20px;
  display: block;
}

.app-name {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--tx);
  white-space: nowrap;
}

/* ---- 右侧 ---- */
.actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.icon-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
  transition: background 0.12s ease;
}

.icon-btn:hover {
  background: var(--bg-hover);
}

.icon-btn svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: var(--tx-3);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* hover 时图标跟着变深，和底色一起给出反馈 */
.icon-btn:hover svg {
  stroke: var(--tx);
}

/*
 * 播放/暂停是实心字形，只吃 fill，不能被上面那条 stroke 描出边。
 * 参数和齿轮完全一致：不常亮底色、同样的灰，状态只靠字形区分。
 */
.icon-btn.toggle svg.fill {
  /* 两根竖条本身比齿轮窄，尺寸给到 15 才和旁边的图标视觉等重 */
  width: 15px;
  height: 15px;
  fill: var(--tx-3);
  stroke: none;
}

.icon-btn.toggle:hover svg.fill {
  fill: var(--tx);
}

.icon-btn.toggle.busy {
  opacity: 0.55;
  cursor: default;
}

.vsep {
  width: 1px;
  height: 16px;
  margin: 0 2px;
  background: var(--line);
}

/* ---- 登录入口 ---- */
.login-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding: 0 10px;
  border: none;
  border-radius: 7px;
  background: var(--bg-hover);
  color: var(--tx);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.login-btn:hover {
  background: var(--bg-active);
}

.login-btn svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.85;
}

/* ---- 账号 ---- */
.account-wrap {
  position: relative;
}

.acct {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 6px 2px 2px;
  border-radius: 7px;
  cursor: pointer;
}

.acct:hover {
  background: var(--bg-hover);
}

.acct.busy {
  opacity: 0.6;
}

.avatar {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--tx);
  color: #fff;
  font-size: 11.5px;
  font-weight: 600;
}

.acct-name {
  font-size: 12.5px;
  color: var(--tx);
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.caret {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: var(--tx-4);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.12s ease;
}

.caret.open {
  transform: rotate(180deg);
}

/* ---- 账号下拉 ---- */
.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  width: 168px;
  padding: 5px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  z-index: 60;
}

.menu-head {
  padding: 5px 8px 7px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--line-soft);
}

.menu-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--tx);
}

.menu-sub {
  margin-top: 1px;
  font-size: 10.5px;
  color: var(--tx-4);
}

.menu-item {
  display: block;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--tx-2);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.menu-item:hover {
  background: var(--bg-hover);
  color: var(--tx);
}

.menu-item.danger:hover {
  background: var(--err-bg);
  color: var(--err);
}

/* ---- 窗口按钮 ---- */
.win-ctrl {
  display: flex;
  /* 40 而不是 41：标题栏总高 41 = 40 内容 + 1 边框，hover 底色不该盖住那根分隔线 */
  height: 40px;
  margin-left: 6px;
}

.wc {
  width: 44px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  cursor: pointer;
}

.wc:hover {
  background: var(--bg-hover);
}

.wc.close:hover {
  background: #e81123;
}

.wc svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: var(--tx-2);
  stroke-width: 1.1;
}

.wc.close:hover svg {
  stroke: #fff;
}

.pop-enter-active,
.pop-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}

.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
