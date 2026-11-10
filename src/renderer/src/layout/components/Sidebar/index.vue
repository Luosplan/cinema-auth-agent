<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { auth, avatarText, displayName, loadAuth, logout } from '../../../stores/auth'
import LoginDialog from '../../../components/LoginDialog.vue'

defineProps({
  running: { type: Boolean, default: false },
  port: { type: Number, default: 0 }
})

const route = useRoute()

const menus = [
  { path: '/dashboard', label: '概览', icon: 'M3 12h3.2l2.4-7 3.6 14 2.6-7H21' },
  {
    path: '/cinemas',
    label: '影城账号',
    icon: 'M3 9.5 12 4l9 5.5M5 11v8.5h14V11M9.5 19.5v-5h5v5'
  },
  {
    path: '/systems',
    label: '系统配置',
    icon: 'M12 3 3 7.6l9 4.6 9-4.6L12 3M3 12.4l9 4.6 9-4.6M3 16.9l9 4.6 9-4.6'
  },
  { path: '/logs', label: '抓包日志', icon: 'M4 6h6M4 12h10M4 18h7M16 15l3 3-3 3' },
  {
    path: '/settings',
    label: '设置',
    icon: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8'
  }
]

const loginOpen = ref(false)
const menuOpen = ref(false)
const loggingOut = ref(false)

const name = computed(() => displayName())
const initial = computed(() => avatarText())
const subline = computed(() => {
  if (!auth.loaded) return ''
  if (!auth.loggedIn) return '点击登录会员账号'
  return auth.member?.phone || '已登录'
})

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

onMounted(() => {
  loadAuth()
  document.addEventListener('click', onDocClick)
})

function onDocClick(e) {
  if (!menuOpen.value) return
  if (e.target.closest?.('.account-wrap')) return
  menuOpen.value = false
}
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <svg class="logo" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="0" y="0" width="24" height="24" rx="6.5" fill="#17181a" />
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
      <div class="brand-text">
        <div class="name">影票授权助手</div>
        <div class="sub">凭证采集端</div>
      </div>
    </div>

    <nav class="nav">
      <router-link
        v-for="item in menus"
        :key="item.path"
        :to="item.path"
        class="nav-item"
        :class="{ active: route.path === item.path }"
      >
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
          <path :d="item.icon" />
        </svg>
        <span class="label">{{ item.label }}</span>
      </router-link>
    </nav>

    <div class="footer">
      <div class="status" :class="{ on: running }">
        <i class="led"></i>
        <span class="status-text">{{ running ? '采集中' : '已停止' }}</span>
        <span class="port mono">{{ running ? `127.0.0.1:${port}` : '' }}</span>
      </div>

      <div class="account-wrap">
        <div
          class="account"
          :class="{ on: auth.loggedIn, busy: loggingOut }"
          role="button"
          tabindex="0"
          @click="onAccountClick"
          @keyup.enter="onAccountClick"
        >
          <div class="avatar" :class="{ empty: !auth.loggedIn }">
            <span v-if="auth.loggedIn">{{ initial }}</span>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 12.4a3.7 3.7 0 1 0 0-7.4 3.7 3.7 0 0 0 0 7.4M4.8 20.2c.6-3.3 3.6-5.4 7.2-5.4s6.6 2.1 7.2 5.4" />
            </svg>
          </div>
          <div class="acc-text">
            <div class="acc-name">{{ name }}</div>
            <div class="acc-sub">{{ subline }}</div>
          </div>
          <svg class="acc-caret" :class="{ open: menuOpen }" viewBox="0 0 24 24" aria-hidden="true">
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
    </div>

    <LoginDialog v-model="loginOpen" />
  </aside>
</template>

<style lang="scss" scoped>
.sidebar {
  position: relative;
  width: 216px;
  flex-shrink: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-right: 1px solid var(--line);
  padding: 12px 9px 9px;
}

/* ---- 品牌 ---- */
.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 2px 7px 14px;
}

.logo {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  display: block;
}

.brand-text {
  min-width: 0;
}

.name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--tx);
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.sub {
  font-size: 10.5px;
  color: var(--tx-4);
  margin-top: 1px;
}

/* ---- 菜单 ---- */
.nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* 菜单全部归在上方一组，剩余空间交给 .footer 兜住状态与账号 */
.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  text-decoration: none;
  color: var(--tx-2);
  font-size: 12.5px;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--tx);
}

.nav-item.active {
  background: #e8e8ea;
  color: var(--tx);
  font-weight: 500;
}

.ico {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.7;
}

.nav-item.active .ico {
  opacity: 1;
}

.label {
  flex: 1;
  white-space: nowrap;
}

/* ---- 底部 ---- */
.footer {
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

.status {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--tx-3);
}

.led {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--tx-4);
  flex-shrink: 0;
}

.status.on .led {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-bg);
}

.status.on {
  color: var(--tx-2);
}

.port {
  margin-left: auto;
  font-size: 10px;
  color: var(--tx-4);
  white-space: nowrap;
}

/* ---- 账号 ---- */
.account-wrap {
  position: relative;
  margin-top: 2px;
}

.account {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 7px;
  border-radius: 7px;
  cursor: pointer;
  border: 1px solid transparent;
  transition:
    background 0.12s ease,
    border-color 0.12s ease;
}

.account:hover {
  background: var(--bg-hover);
}

.account.on:hover {
  background: #fff;
  border-color: rgba(0, 0, 0, 0.06);
}

.avatar {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  overflow: hidden;
}

.avatar.empty {
  background: var(--bg-active);
  color: var(--tx-4);
}

.avatar svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
}

.acc-text {
  min-width: 0;
  flex: 1;
}

.acc-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--tx);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.acc-sub {
  font-size: 10.5px;
  color: var(--tx-4);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.acc-caret {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  fill: none;
  stroke: var(--tx-4);
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0;
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}

.account:hover .acc-caret,
.acc-caret.open {
  opacity: 1;
}

/* ---- 弹出菜单 ---- */
.menu {
  position: absolute;
  left: 2px;
  right: 2px;
  bottom: calc(100% + 6px);
  padding: 5px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
  z-index: 20;
}

.menu-head {
  padding: 5px 8px 7px;
  border-bottom: 1px solid var(--line-soft);
  margin-bottom: 4px;
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

.pop-enter-active,
.pop-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}

.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
