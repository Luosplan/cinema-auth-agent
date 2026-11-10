<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { invoke } from '@utils/ipc'

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
  <div class="page">
    <div class="page-inner">
      <div class="page-head">
        <div>
          <h1 class="page-title">系统配置</h1>
          <p class="page-desc">
            只有这里列出的域名会被解密，其余流量原样直通，不影响客户机上的其他网站。支持
            <code class="mono">*.example.com</code> 通配。
          </p>
        </div>
      </div>

      <div v-if="!rules.length" class="empty-box">规则加载中…</div>

      <div v-else class="rules">
        <div v-for="rule in rules" :key="rule.id" class="rule">
          <div class="rule-head">
            <div class="rule-id">
              <span class="rule-name">{{ rule.name }}</span>
              <span class="pill" :class="drafts[rule.id]?.hosts.length ? 'ok' : ''">
                {{ drafts[rule.id]?.hosts.length ? '采集中' : '未配置' }}
              </span>
            </div>
            <el-switch v-model="drafts[rule.id].enabled" size="small" @change="save(rule.id)" />
          </div>

          <div class="field">
            <span class="field-label">域名</span>
            <div class="field-body">
              <div class="host-tags">
                <span v-for="host in drafts[rule.id].hosts" :key="host" class="host">
                  <span class="mono">{{ host }}</span>
                  <button class="host-x" title="移除" @click="removeHost(rule.id, host)">×</button>
                </span>
                <span v-if="!drafts[rule.id].hosts.length" class="host-empty">尚未添加</span>
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

          <div class="rule-foot">
            <span class="k">过期策略</span>
            <span class="v">{{ EXPIRY_TEXT[rule.expiry?.type] || '未知' }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.rules {
  margin-top: 4px;
  border-top: 1px solid var(--line-soft);
}

.rule {
  padding: 14px 10px 16px;
  margin: 0 -10px;
  border-bottom: 1px solid var(--line-soft);
}

.rule:last-child {
  border-bottom: none;
}

.rule-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.rule-id {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rule-name {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--tx);
}

/* 标签 - 值 的栅格，比上下堆叠更省纵向空间 */
.field {
  display: flex;
  gap: 14px;
  margin-top: 12px;
}

.field-label {
  width: 34px;
  flex-shrink: 0;
  padding-top: 4px;
  font-size: 11.5px;
  color: var(--tx-4);
}

.field-body {
  flex: 1;
  min-width: 0;
}

.host-tags {
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
  font-size: 11.5px;
  border-radius: 4px;
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

.rule-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-left: 48px;
  font-size: 11.5px;
}

.rule-foot .k {
  color: var(--tx-4);
}

.rule-foot .v {
  color: var(--tx-3);
}

code {
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-hover);
  font-size: 11px;
}
</style>
