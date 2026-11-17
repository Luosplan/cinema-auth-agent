<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { invoke, on } from '@utils/ipc'
import { proxyStatus } from '@renderer/stores/proxy'
import { ui } from '@renderer/stores/ui'

/**
 * 网络抓包：和 Reqable 一样，左边实时请求列表，右边看报文详情。
 *
 * 数据来源就是主进程现有的 ctx.captures —— 启动采集后 MitmProxy 只解密白名单域名，
 * 记录通过 capture-batch 批量推过来。实时推送的记录自带完整报文，直接缓存在渲染层，
 * 点开即可看；只有启动时补拉的历史记录（列表不带 body）才回主进程按 id 取详情。
 */
const MAX_ROWS = 300
/** 完整报文只在渲染层留最近 100 条：点开就能看，也不至于把几百 KB 的大响应堆满内存 */
const MAX_CACHE = 100

const rows = ref([])
const cache = new Map()
const keyword = ref('')
/** 空字符串会被 el-select 当成未选中，用 ALL 表示「全部方法」才能默认显示出来 */
const methodFilter = ref('ALL')
/** 是否隐藏无用请求，跟随「设置 → 通用 → 过滤静态资源」，默认开启 */
const hideNoise = ref(true)
const activeId = ref('')
const activeTab = ref('overview')
const detail = ref(null)
const loadError = ref('')
/** 各规则声明的凭证字段名（mobile / token / authorization / openid ...），从主进程取 */
const credKeys = ref(['authorization', 'token', 'cookie', 'openid', 'mobile'])

const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'reqHeaders', label: '请求头' },
  { key: 'reqBody', label: '请求体' },
  { key: 'resHeaders', label: '响应头' },
  { key: 'resBody', label: '响应体' },
  { key: 'cred', label: '凭证参数' }
]

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/** 静态资源后缀：脚本、样式、图片、字体、音视频 */
const STATIC_EXT =
  /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|svg|ico|bmp|avif|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|flac)(?:$|\?)/i

/**
 * 无用请求：预检 OPTIONS、静态资源、图片/字体/媒体。
 * 只看请求路径和响应 Content-Type，不碰接口返回的 JSON。
 */
function isNoise(row) {
  if (row.method === 'OPTIONS') return true
  const ct = String(row.contentType || '').toLowerCase()
  if (ct) {
    if (/^(?:image|font|audio|video)\//.test(ct)) return true
    if (/^(?:text\/css|text\/javascript|application\/(?:javascript|x-javascript|ecmascript|wasm))/.test(ct)) {
      return true
    }
  }
  return STATIC_EXT.test(row.path || '')
}

/** 新记录在前，和抓包工具的阅读习惯一致 */
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list = []
  for (let i = rows.value.length - 1; i >= 0; i -= 1) {
    const row = rows.value[i]
    if (hideNoise.value && isNoise(row)) continue
    if (methodFilter.value !== 'ALL' && row.method !== methodFilter.value) continue
    if (
      kw &&
      !`${row.method} ${row.host} ${row.path} ${row.statusCode || ''}`.toLowerCase().includes(kw)
    ) {
      continue
    }
    list.push(row)
  }
  return list
})

/** 被过滤掉的条数，列表头提示用 */
const hiddenCount = computed(() => {
  if (!hideNoise.value) return 0
  let count = 0
  for (const row of rows.value) if (isNoise(row)) count += 1
  return count
})

function contentTypeOf(headers) {
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === 'content-type') return String(Array.isArray(v) ? v[0] : v)
  }
  return ''
}

function summarize(r) {
  return {
    id: r.id,
    at: r.at,
    host: r.host,
    method: r.method,
    path: r.path,
    statusCode: r.statusCode,
    duration: r.duration,
    contentType: r.contentType || contentTypeOf(r.resHeaders)
  }
}

function pushRecords(list, full) {
  const incoming = (list || []).filter(Boolean)
  if (!incoming.length) return
  if (full) {
    for (const r of incoming) {
      // Map 保持插入顺序，超量就从最早的开始丢
      if (!cache.has(r.id) && cache.size >= MAX_CACHE) {
        cache.delete(cache.keys().next().value)
      }
      cache.set(r.id, r)
    }
  }
  rows.value.push(...incoming.map(summarize))
  if (rows.value.length > MAX_ROWS) rows.value.splice(0, rows.value.length - MAX_ROWS)
}

async function select(id) {
  activeId.value = id
  // 点开请求直接看凭证参数，省得再手动切页签
  activeTab.value = 'cred'
  loadError.value = ''
  // 实时推送里本来就带完整报文，优先用本地缓存，点击立即出结果
  let record = cache.get(id)
  if (!record) {
    record = await invoke('captures:detail', { id }).catch(() => null)
  }
  // 连点两条时只认最后一次选择的结果
  if (activeId.value !== id) return
  if (record) {
    detail.value = record
    return
  }
  // 报文已被新流量覆盖：至少把列表里的概览留住
  const row = rows.value.find((r) => r.id === id)
  detail.value = row ? { ...row } : null
  loadError.value = '这条请求的报文已经过期，只剩概览。重新操作一次目标页面再点开即可看到完整参数。'
}

async function loadFilterPref() {
  const cfg = await invoke('config:get').catch(() => null)
  hideNoise.value = cfg?.app?.filterNoise !== false
}

async function onClear() {
  await invoke('captures:clear')
  rows.value = []
  cache.clear()
  detail.value = null
  loadError.value = ''
  activeId.value = ''
}

function methodClass(method) {
  if (method === 'POST') return 'post'
  if (method === 'PUT' || method === 'PATCH') return 'put'
  if (method === 'DELETE') return 'del'
  return ''
}

function statusClass(code) {
  if (!code) return 'dim'
  if (code < 300) return 'ok'
  if (code < 400) return 'warn'
  return 'err'
}

/** JSON 自动缩进；不是 JSON 就原样显示 */
function pretty(text) {
  const raw = String(text || '')
  if (!raw.trim()) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function headerEntries(headers) {
  return Object.entries(headers || {}).sort(([a], [b]) => a.localeCompare(b))
}

function sizeText(text) {
  const len = new Blob([String(text || '')]).size
  if (len < 1024) return `${len} B`
  return `${(len / 1024).toFixed(1)} KB`
}

/**
 * 抓包需要的参数名：token / TOKEN / Token 大小写都算，也兼容 accessToken 这类后缀写法；
 * 手机号等登录必填字段的常见叫法一并收进来。
 */
const EXTRA_CRED_KEYS = [
  'authorization',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'cookie',
  'session',
  'sessionid',
  'ticket',
  'secret',
  'password',
  'passwd',
  'openid',
  'unionid',
  'memberid',
  'mobile',
  'mobilephone',
  'phone',
  'tel',
  'telephone',
  'apikey',
  'appkey',
  'secretkey',
  'x-token',
  'third-session',
  'sign',
  'key',
  'k'
]

/** 请求头只认这些明确带凭证的头，避免把 sec-ch-ua-mobile 这类客户端提示当成手机号 */
const HEADER_CRED_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'token',
  'x-token',
  'x-access-token',
  'access-token',
  'auth-token',
  'x-auth-token',
  'third-session',
  'session',
  'sessionid',
  'session-id',
  'sid',
  'sign',
  'signature',
  'x-sign',
  'secret',
  'apikey',
  'api-key',
  'appkey'
])

const credWords = computed(
  () =>
    new Set(
      [...EXTRA_CRED_KEYS, ...credKeys.value]
        .map((k) => String(k || '').trim().toLowerCase())
        .filter(Boolean)
    )
)

/** 字段名就是凭证名，或以后缀形式出现（accessToken、userMobile） */
function isCredKey(key) {
  const k = String(key || '').trim().toLowerCase()
  if (!k) return false
  for (const word of credWords.value) {
    if (k === word) return true
    if (word.length >= 4 && k.endsWith(word)) return true
  }
  return false
}

function isCredHeader(name) {
  const n = String(name || '').trim().toLowerCase()
  return HEADER_CRED_NAMES.has(n) || n.endsWith('-token') || n.endsWith('-session')
}

/** 请求体可能是 JSON 字符串、对象或 a=1&b=2 表单，尽量都拆开 */
function parseBody(body) {
  if (body == null || body === '') return null
  if (typeof body === 'object') return body
  const raw = String(body).trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    if (!raw.includes('=') || raw.includes('<')) return null
    const obj = {}
    for (const pair of raw.split('&')) {
      const [k, v = ''] = pair.split('=')
      if (!k) continue
      try {
        obj[decodeURIComponent(k)] = decodeURIComponent(v)
      } catch {
        obj[k] = v
      }
    }
    return obj
  }
}

/** 递归找凭证字段，path 只用来提示位置，展示时只显示字段名 */
function walkCred(body, depth, path, visit) {
  if (body == null || depth > 6) return
  if (Array.isArray(body)) {
    body.slice(0, 30).forEach((item, i) => walkCred(item, depth + 1, `${path}[${i}]`, visit))
    return
  }
  if (typeof body !== 'object') return
  for (const [k, v] of Object.entries(body)) {
    const next = path ? `${path}.${k}` : k
    if (isCredKey(k) && (v == null || typeof v !== 'object')) visit(k, next, v)
    walkCred(v, depth + 1, next, visit)
  }
}

/** 明显不是有效凭证的值直接跳过：空值、0、false、null、短数字等 */
function isUsefulCredValue(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text) return false
  const lower = text.toLowerCase()
  if (['0', 'false', 'null', 'undefined', 'none', 'nil', 'nan', '-', '--', '[]', '{}'].includes(lower)) {
    return false
  }
  // token: 0、token: 123 这种短数字肯定不是凭证；手机号是 11 位，不受影响
  if (/^\d+$/.test(text) && text.length < 6) return false
  return true
}

/** 抓包需要的参数汇总：把请求头、响应头、请求体、响应体里的凭证字段挑出来 */
const credParams = computed(() => {
  if (!detail.value) return []
  const out = []
  const seen = new Set()
  const add = (source, key, path, value) => {
    const text = value == null ? '' : String(value)
    if (!isUsefulCredValue(text)) return
    // 同一个参数在报文里出现多次（不同层级、请求/响应都有）时只保留一条
    const id = `${key}|${text}`
    if (seen.has(id)) return
    seen.add(id)
    out.push({ source, key, path: path || key, value: text })
  }
  const scanHeaders = (source, headers) => {
    for (const [k, v] of Object.entries(headers || {})) {
      if (isCredHeader(k)) add(source, k, k, Array.isArray(v) ? v.join('; ') : v)
    }
  }
  scanHeaders('请求头', detail.value.reqHeaders)
  scanHeaders('响应头', detail.value.resHeaders)
  for (const [source, body] of [
    ['请求体', detail.value.reqBody],
    ['响应体', detail.value.resBody]
  ]) {
    const parsed = parseBody(body)
    if (parsed) walkCred(parsed, 0, '', (key, path, value) => add(source, key, path, value))
  }
  return out
})

async function copyCred(value) {
  try {
    await navigator.clipboard.writeText(String(value || ''))
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选中复制')
  }
}

let offCapture = null

onMounted(async () => {
  await loadFilterPref()
  invoke('rules:params')
    .then((keys) => {
      if (Array.isArray(keys) && keys.length) credKeys.value = keys
    })
    .catch(() => {})
  const list = await invoke('captures:list', { limit: MAX_ROWS }).catch(() => [])
  pushRecords(list, false)
  offCapture = on('capture-batch', (batch) => pushRecords(batch, true))
})

// 设置弹窗关掉时重新读一次，开关改完立刻生效
watch(
  () => ui.settingsOpen,
  (open) => {
    if (!open) loadFilterPref()
  }
)

onUnmounted(() => {
  if (offCapture) offCapture()
})
</script>

<template>
  <div class="traffic">
    <div class="head">
      <h1 class="head-title">网络抓包</h1>
      <div class="head-actions">
        <el-select v-model="methodFilter" size="small" class="method-filter">
          <el-option label="全部方法" value="ALL" />
          <el-option v-for="m in METHODS" :key="m" :label="m" :value="m" />
        </el-select>
        <el-input
          v-model="keyword"
          size="small"
          placeholder="筛选域名 / 路径 / 状态"
          clearable
          class="search"
        />
        <el-button size="small" :disabled="!rows.length" @click="onClear">清空</el-button>
      </div>
    </div>

    <div class="split">
      <!-- 左：请求列表 -->
      <section class="list-pane">
        <div class="list-head">
          <span>请求</span>
          <span class="count">
            {{ filtered.length }}
            <template v-if="hiddenCount"> · 已过滤 {{ hiddenCount }}</template>
          </span>
        </div>
        <div class="list">
          <div
            v-for="row in filtered"
            :key="row.id"
            class="row"
            :class="{ active: row.id === activeId }"
            @click="select(row.id)"
          >
            <span class="m mono" :class="methodClass(row.method)">{{ row.method }}</span>
            <span class="st mono" :class="statusClass(row.statusCode)">
              {{ row.statusCode || '—' }}
            </span>
            <span class="host mono" :title="row.host">{{ row.host }}</span>
            <span class="path mono" :title="row.path">{{ row.path }}</span>
            <span class="dur mono">{{ row.duration == null ? '' : `${row.duration}ms` }}</span>
          </div>

          <div v-if="!filtered.length" class="empty">
            <template v-if="!proxyStatus.running">
              采集未开启。点标题栏的采集开关后，在浏览器或微信里操作目标页面，请求会实时出现在这里。
            </template>
            <template v-else-if="rows.length">
              <template v-if="hiddenCount && !keyword.trim() && methodFilter === 'ALL'">
                已过滤掉 {{ hiddenCount }} 条静态资源、图片或预检请求；可在「设置 → 通用」里关闭过滤。
              </template>
              <template v-else>没有匹配的请求，换个筛选词试试。</template>
            </template>
            <template v-else>正在等待请求… 只记录命中白名单域名且证书已解密的请求。</template>
          </div>
        </div>
      </section>

      <!-- 右：报文详情 -->
      <section class="detail-pane">
        <template v-if="detail">
          <div class="detail-head">
            <span class="m mono" :class="methodClass(detail.method)">{{ detail.method }}</span>
            <span class="url mono" :title="`${detail.host}${detail.path}`">
              {{ detail.host }}{{ detail.path }}
            </span>
            <span class="st mono" :class="statusClass(detail.statusCode)">
              {{ detail.statusCode || '—' }}
            </span>
          </div>

          <div class="tabs">
            <button
              v-for="tab in TABS"
              :key="tab.key"
              class="tab"
              :class="{ active: activeTab === tab.key }"
              @click="activeTab = tab.key"
            >
              {{ tab.label }}
            </button>
          </div>

          <div class="detail-body">
            <template v-if="activeTab === 'overview'">
              <div class="kv">
                <div class="k">请求地址</div>
                <div class="v mono">{{ detail.host }}{{ detail.path }}</div>
              </div>
              <div class="kv">
                <div class="k">状态码</div>
                <div class="v mono" :class="statusClass(detail.statusCode)">
                  {{ detail.statusCode || '—' }}
                </div>
              </div>
              <div class="kv">
                <div class="k">耗时</div>
                <div class="v mono">{{ detail.duration == null ? '—' : `${detail.duration}ms` }}</div>
              </div>
              <div class="kv">
                <div class="k">时间</div>
                <div class="v mono">{{ (detail.at || '').replace('T', ' ').slice(0, 19) }}</div>
              </div>
              <div class="kv">
                <div class="k">请求体</div>
                <div class="v mono">{{ sizeText(detail.reqBody) }}</div>
              </div>
              <div class="kv">
                <div class="k">响应体</div>
                <div class="v mono">{{ sizeText(detail.resBody) }}</div>
              </div>
              <p v-if="detail.truncated" class="note">响应体超过 512 KB，只保留了前半段。</p>
              <p v-if="loadError" class="note">{{ loadError }}</p>
            </template>

            <template v-else-if="activeTab === 'reqHeaders' || activeTab === 'resHeaders'">
              <div v-if="!headerEntries(detail[activeTab]).length" class="empty">
                没有记录到请求头。
              </div>
              <div v-else class="headers">
                <div
                  v-for="[k, v] in headerEntries(detail[activeTab])"
                  :key="k"
                  class="header-row"
                >
                  <span class="hk mono">{{ k }}</span>
                  <span class="hv mono">{{ v }}</span>
                </div>
              </div>
            </template>

            <template v-else-if="activeTab === 'cred'">
              <div v-if="!credParams.length" class="empty">
                这条报文里没有发现凭证相关参数（token、authorization、cookie、mobile 等）。
              </div>
              <div v-else class="creds">
                <div v-for="(p, i) in credParams" :key="i" class="cred-row">
                  <span class="cred-src">{{ p.source }}</span>
                  <span class="cred-key mono" :title="p.path !== p.key ? p.path : ''">
                    {{ p.key }}
                  </span>
                  <span class="cred-val mono" :title="p.value">{{ p.value }}</span>
                  <button class="cred-copy" @click="copyCred(p.value)">复制</button>
                </div>
              </div>
            </template>

            <template v-else>
              <pre v-if="pretty(detail[activeTab])" class="body mono">{{
                pretty(detail[activeTab])
              }}</pre>
              <div v-else class="empty">
                {{ activeTab === 'reqBody' ? '没有请求体。' : '没有响应体（重定向、304 或缓存命中）。' }}
              </div>
            </template>
          </div>
        </template>

        <div v-else class="empty center">
          {{ loadError || '选择左侧一条请求查看报文详情' }}
        </div>
      </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.traffic {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 15px 0 0;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 0 26px 14px;
}

.head-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--tx);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.method-filter {
  width: 108px;
}

.search {
  width: 200px;
}

/* ---- 左右分栏 ---- */
.split {
  flex: 1;
  min-height: 0;
  display: flex;
  border-top: 1px solid var(--line-soft);
}

.list-pane {
  width: 52%;
  min-width: 380px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line-soft);
}

.list-head {
  flex-shrink: 0;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 8px 16px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--tx-4);
}

.list-head .count {
  font-weight: 400;
  letter-spacing: 0;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 12px;
}

.row {
  display: grid;
  grid-template-columns: 54px 42px minmax(96px, 0.8fr) minmax(0, 1.6fr) 56px;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius);
  font-size: 12px;
  cursor: pointer;
}

.row:hover {
  background: var(--bg-hover);
}

.row.active {
  background: var(--bg-active);
  box-shadow: inset 2px 0 0 var(--tx);
}

.m,
.st {
  font-size: 11px;
  color: var(--tx-2);
}

.m.post {
  color: var(--ok);
}

.m.put {
  color: var(--warn);
}

.m.del {
  color: var(--err);
}

.st.ok {
  color: var(--ok);
}

.st.warn {
  color: var(--warn);
}

.st.err {
  color: var(--err);
}

.st.dim {
  color: var(--tx-4);
}

.host {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--tx);
}

.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--tx-3);
  font-size: 11.5px;
}

.dur {
  text-align: right;
  font-size: 11px;
  color: var(--tx-4);
}

/* ---- 详情 ---- */
.detail-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.detail-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px 8px;
}

.detail-head .url {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--tx);
}

.tabs {
  flex-shrink: 0;
  display: flex;
  gap: 2px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line-soft);
}

.tab {
  height: 28px;
  padding: 0 10px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  color: var(--tx-3);
  cursor: pointer;
}

.tab:hover {
  color: var(--tx);
}

.tab.active {
  color: var(--tx);
  border-bottom-color: var(--tx);
  font-weight: 500;
}

.detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 18px 24px;
}

.kv {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 12px;
  padding: 5px 0;
  font-size: 12px;
}

.kv .k {
  color: var(--tx-3);
}

.kv .v {
  color: var(--tx);
  word-break: break-all;
}

.kv .v.ok {
  color: var(--ok);
}

.kv .v.warn {
  color: var(--warn);
}

.kv .v.err {
  color: var(--err);
}

.note {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--warn);
}

.headers {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.header-row {
  display: grid;
  grid-template-columns: minmax(120px, 34%) minmax(0, 1fr);
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--line-soft);
  font-size: 11.5px;
}

.hk {
  color: var(--tx-2);
  word-break: break-all;
}

/* ---- 凭证参数 tab ---- */
.creds {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-panel);
  overflow: hidden;
}

.cred-row {
  display: grid;
  grid-template-columns: 52px minmax(110px, 0.7fr) minmax(0, 1.6fr) 44px;
  gap: 10px;
  align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line-soft);
  font-size: 11.5px;
}

.cred-row:last-child {
  border-bottom: none;
}

.cred-src {
  color: var(--tx-4);
}

.cred-key {
  color: var(--warn);
  word-break: break-all;
}

.cred-val {
  color: var(--tx-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}

.cred-copy {
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--tx-3);
  cursor: pointer;
}

.cred-copy:hover {
  color: var(--tx);
}

.hv {
  color: var(--tx-3);
  word-break: break-all;
  user-select: text;
}

.body {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-panel);
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--tx-2);
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}

.empty {
  padding: 22px 6px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--tx-3);
}

.empty.center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 24px;
  text-align: center;
}
</style>
