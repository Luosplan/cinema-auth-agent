<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { invoke } from '@utils/ipc'

const rules = ref([])
const drafts = reactive({})
const inputs = reactive({})
const saving = ref('')

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
    <div class="page-head">
      <h2>系统配置</h2>
      <p>
        只有这里列出的域名会被解密，其余流量全部原样直通，不影响客户机上任何其他网站。
        域名格式支持通配，例如 <code class="mono">*.example.com</code>。
      </p>
    </div>

    <div v-for="rule in rules" :key="rule.id" class="rule-card">
      <div class="rule-head">
        <div class="rule-title">
          <span class="rule-name">{{ rule.name }}</span>
          <el-tag
            size="small"
            :type="drafts[rule.id]?.hosts.length ? 'success' : 'info'"
            effect="light"
          >
            {{ drafts[rule.id]?.hosts.length ? '采集中' : '未配置域名' }}
          </el-tag>
        </div>
        <el-switch
          v-model="drafts[rule.id].enabled"
          active-text="启用"
          @change="save(rule.id)"
        />
      </div>

      <div class="field">
        <div class="field-label">接口域名</div>
        <div class="host-list">
          <el-tag
            v-for="host in drafts[rule.id].hosts"
            :key="host"
            closable
            size="small"
            class="host-tag"
            @close="removeHost(rule.id, host)"
          >
            {{ host }}
          </el-tag>
          <span v-if="!drafts[rule.id].hosts.length" class="host-empty">尚未添加</span>
        </div>
        <div class="host-add">
          <el-input
            v-model="inputs[rule.id]"
            size="small"
            placeholder="例如 app.example.com"
            style="width: 260px"
            @keyup.enter="addHost(rule.id)"
          />
          <el-button size="small" @click="addHost(rule.id)">添加</el-button>
          <el-button
            size="small"
            type="primary"
            :loading="saving === rule.id"
            @click="save(rule.id)"
          >
            保存
          </el-button>
        </div>
      </div>

      <div class="rule-foot">
        <span class="foot-key">过期策略</span>
        <span class="foot-val">{{ EXPIRY_TEXT[rule.expiry?.type] || '未知' }}</span>
      </div>
    </div>

    <div v-if="!rules.length" class="empty">规则加载中…</div>
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
  margin: 0 0 18px;
  font-size: 12px;
  color: #8b94a4;
  line-height: 1.8;
}

.page-head code {
  background: #f0f3f9;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 11px;
}

.rule-card {
  background: #fff;
  border: 1px solid #e8eaf0;
  border-radius: 10px;
  padding: 16px 18px;
  margin-bottom: 12px;
}

.rule-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.rule-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.rule-name {
  font-size: 14px;
  font-weight: 500;
  color: #1b2330;
}

.field {
  margin-top: 16px;
}

.field-label {
  font-size: 12px;
  color: #9aa3b2;
  margin-bottom: 8px;
}

.host-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
  align-items: center;
}

.host-tag {
  font-family: ui-monospace, Menlo, Consolas, monospace;
}

.host-empty {
  font-size: 12px;
  color: #c0c6d2;
}

.host-add {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.rule-foot {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #f2f4f8;
  font-size: 12px;
}

.foot-key {
  color: #9aa3b2;
  margin-right: 8px;
}

.foot-val {
  color: #4a5568;
}

.empty {
  text-align: center;
  color: #a8b0be;
  font-size: 12px;
  padding: 40px;
}
</style>
