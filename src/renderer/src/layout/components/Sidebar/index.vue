<script setup>
import { useRoute } from 'vue-router'

const route = useRoute()

const menus = [
  { path: '/dashboard', label: '概览', hint: '凭证状态' },
  { path: '/systems', label: '系统配置', hint: '域名与规则' },
  { path: '/logs', label: '抓包日志', hint: '实时流量' },
  { path: '/settings', label: '设置', hint: '证书与上报' }
]
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">票</div>
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
        <span class="dot"></span>
        <span class="label">{{ item.label }}</span>
        <span class="hint">{{ item.hint }}</span>
      </router-link>
    </nav>

    <div class="footer">
      <div class="tip">采集中请勿关闭微信</div>
    </div>
  </aside>
</template>

<style lang="scss" scoped>
.sidebar {
  width: 208px;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border-right: 1px solid #e8eaf0;
  padding: 18px 12px 14px;
  box-sizing: border-box;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 6px 18px;
}

.logo {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: #2f6feb;
  color: #fff;
  font-size: 15px;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.brand-text {
  min-width: 0;
}

.name {
  font-size: 13px;
  font-weight: 500;
  color: #1b2330;
  letter-spacing: 0.2px;
}

.sub {
  font-size: 11px;
  color: #9aa3b2;
  margin-top: 2px;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 7px;
  text-decoration: none;
  color: #4a5568;
  font-size: 13px;
  transition: background 0.15s;
}

.nav-item:hover {
  background: #f5f7fb;
}

.nav-item.active {
  background: #eef4ff;
  color: #2f6feb;
}

.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #cfd6e4;
  flex-shrink: 0;
}

.nav-item.active .dot {
  background: #2f6feb;
}

.label {
  flex: 1;
}

.hint {
  font-size: 11px;
  color: #b3bbc9;
}

.nav-item.active .hint {
  color: #9db8ee;
}

.footer {
  padding: 10px 8px 0;
  border-top: 1px solid #f0f2f7;
}

.tip {
  font-size: 11px;
  color: #b3bbc9;
  line-height: 1.5;
}
</style>
