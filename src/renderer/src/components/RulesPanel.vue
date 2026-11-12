<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { invoke } from '@utils/ipc'

/**
 * 抓包规则（哪些域名解密、哪些直通）。
 *
 * 原来是一个独立页面（系统配置），设置改成弹窗后收进「抓包规则」这一栏：
 * 规则是低频改动，占一整页导航不值得，但也不能丢 —— 只有这里列出的域名会被解密，
 * 其余流量原样直通，配错了就一条凭证也采不到。
 *
 * 草稿与已保存值分开存：域名是逐个增删的，点「添加」不该立刻落盘，
 * 否则删错一个域名就得重来一遍。
 */
const rules = ref([])
const drafts = reactive({})
const inputs = reactive({})
const savedHosts = reactive({})
const saving = ref('')

const dirty = (id) => !!drafts[id] && drafts[id].hosts.join('|') !== savedHosts[id]

const EXPIRY_TEXT = {
  sliding: '滑动续期（有心跳就不失效）',
  absolute: '绝对过期（到点必须重新登录）'
}

async function load() {
  const list = await invoke('rules:list')
  rules.value = list || []
  for (const rule of rules.value) {
    drafts[rule.id] = {
      hosts: [...(rule.hosts || [])],
      enabled: rule.enabled !== false
    }
    savedHosts[rule.id] = drafts[rule.id].hosts.join('|')
    if (!inputs[rule.id]) inputs[rule.id] = ''
  }
}

function addHost(ruleId) {
  const value = (inputs[ruleId] || '').trim().toLowerCase()
  if (!value) return
  if (!/^[a-z0-9*.-]+$/.test(value)) {
    ElMessage.warning('域名格式不正确')
    return
  }
  const list = drafts[ruleId].hosts
  if (list.includes(value)) {
    ElMessage.warning('该域名已存在')
    return
  }
  list.push(value)
  inputs[ruleId] = ''
}

function removeHost(ruleId, host) {
  const list = drafts[ruleId].hosts
  const idx = list.indexOf(host)
  if (idx > -1) list.splice(idx, 1)
}

async function save(ruleId) {
  saving.value = ruleId
  try {
    const draft = drafts[ruleId]
    await invoke('config:update', {
      rules: {
        [ruleId]: {
          hosts: draft.hosts,
          enabled: draft.enabled
        }
      }
    })
    ElMessage.success('已保存，规则立即生效')
    await load()
  } catch (e) {
    ElMessage.error(`保存失败：${e.message}`)
  } finally {
    saving.value = ''
  }
}

onMounted(load)
</script>

<template>
  <div class="grp">解密范围</div>
  <p class="hint">
    只有这里列出的域名会被解密，其余流量原样直通，不影响客户机上的其他网站。支持
    <code class="mono">*.example.com</code> 通配。
  </p>

  <div v-if="!rules.length" class="card">
    <div class="row">
      <div class="row-main">
        <div class="row-desc">规则加载中…</div>
      </div>
    </div>
  </div>

  <template v-else>
    <div v-for="rule in rules" :key="rule.id" class="card">
      <div class="row">
        <div class="row-main">
          <div class="row-title">
            {{ rule.name }}
            <span class="pill" :class="{ on: drafts[rule.id]?.hosts.length }">
              {{ drafts[rule.id]?.hosts.length ? '采集中' : '未配置' }}
            </span>
          </div>
          <div class="row-desc">过期策略：{{ EXPIRY_TEXT[rule.expiry?.type] || '未知' }}</div>
        </div>
        <el-switch v-model="drafts[rule.id].enabled" size="small" @change="save(rule.id)" />
      </div>

      <div class="row col">
        <div class="hosts">
          <span v-for="host in drafts[rule.id].hosts" :key="host" class="host">
            <span class="mono">{{ host }}</span>
            <button class="host-x" title="移除" @click="removeHost(rule.id, host)">×</button>
          </span>
          <span v-if="!drafts[rule.id].hosts.length" class="host-empty">尚未添加域名</span>
        </div>

        <div class="host-add">
          <el-input
            v-model="inputs[rule.id]"
            size="small"
            placeholder="app.example.com"
            class="host-input"
            @keyup.enter="addHost(rule.id)"
          />
          <el-button size="small" @click="addHost(rule.id)">添加</el-button>
          <el-button
            size="small"
            type="primary"
            :loading="saving === rule.id"
            :disabled="!dirty(rule.id)"
            @click="save(rule.id)"
          >
            保存
          </el-button>
        </div>
      </div>
    </div>
  </template>
</template>

<style lang="scss" scoped>
.grp {
  padding: 2px 2px 7px;
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--tx-4);
}

.hint {
  margin: 0 2px 10px;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--tx-3);
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

/* 域名那一行是竖向堆叠：标签 + 输入框一行放不下，挤在一起反而难认 */
.row.col {
  display: block;
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

.pill {
  height: 17px;
  padding: 0 6px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--tx-4);
  background: var(--bg-hover);
}

.pill.on {
  color: var(--ok);
  background: var(--ok-bg);
}

.hosts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 22px;
  align-items: center;
}

.host {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 4px 0 7px;
  border-radius: 4px;
  font-size: 11.5px;
  color: var(--tx-2);
  background: var(--bg-hover);
}

.host-x {
  width: 15px;
  height: 15px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--tx-4);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.host-x:hover {
  background: rgba(0, 0, 0, 0.07);
  color: var(--tx);
}

.host-empty {
  font-size: 11.5px;
  color: var(--tx-4);
}

.host-add {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.host-input {
  width: 230px;
}

/* 与 small 输入框（26px）取齐，默认 small 按钮只有 24px */
.host-add .el-button {
  height: 26px;
}

code {
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-hover);
  font-size: 11px;
}
</style>
