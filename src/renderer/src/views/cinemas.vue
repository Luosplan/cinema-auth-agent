<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { invoke } from '@utils/ipc'
import { auth, loadAuth } from '../stores/auth'
import { setCinemaStats } from '../stores/stats'
import LoginDialog from '../components/LoginDialog.vue'
import CopyIcon from '../components/CopyIcon.vue'

const tree = ref([])
const accountsMap = ref({})
const activeSystemId = ref(0)
const keyword = ref('')
/** 接入方式筛选：'' 全部 / h5 / miniapp */
const typeFilter = ref('')
/** 账号配置筛选：'' 全部 / has 已有账号 / none 未配置账号 */
const accountFilter = ref('')
const loading = ref(false)
const accountsLoading = ref(false)
const error = ref('')
const loginOpen = ref(false)

const paramDialog = ref(false)
const detailDialog = ref(false)
const dialogCinema = ref(null)

/** 表头 + 行的列宽：合并单元格靠 rowspan 撑开，宽度必须固定，否则会随账号数抖动
 *  标签列按「pill 实际宽度 + padding」倒推，窄了会被 text-overflow 截成「启用…」 */
const COLS = ['33%', '10%', '22%', '8%', '8%', '16%']

const activeSystem = computed(() => tree.value.find((s) => s.id === activeSystemId.value) || null)

const cinemas = computed(() => activeSystem.value?.children || [])

/** 归一化接入方式：accessType 是 h5 / miniapp（服务端可能给 mini），个别数据只有 protocol */
function typeOf(cinema) {
  const raw = String(cinema?.accessType || cinema?.protocol || '').toLowerCase()
  if (raw === 'h5') return 'h5'
  if (raw === 'miniapp' || raw === 'mini' || raw === 'miniprogram' || raw === 'wx') return 'miniapp'
  return ''
}

const filteredCinemas = computed(() => {
  // 只按影城名搜：编码和账号另有筛选口径，塞进同一个输入框反而不好预期
  const kw = keyword.value.trim().toLowerCase()
  return cinemas.value.filter((c) => {
    if (typeFilter.value && typeOf(c) !== typeFilter.value) return false
    const n = accountsMap.value[c.id]?.length || 0
    if (accountFilter.value === 'has' && !n) return false
    if (accountFilter.value === 'none' && n) return false
    if (!kw) return true
    return String(c.name || '').toLowerCase().includes(kw)
  })
})

/** 有没有生效中的筛选条件：没有时「重置」置灰，别给一个点了没反应的按钮 */
const hasFilter = computed(
  () => !!accountFilter.value || !!typeFilter.value || !!keyword.value.trim()
)

const totalAccounts = computed(() =>
  cinemas.value.reduce((sum, c) => sum + (accountsMap.value[c.id]?.length || 0), 0)
)

/** 一个影城可能是 0 个、2 个、3 个账号：行数取账号数，没有账号也占一行看空态 */
function rowsOf(cinema) {
  const list = accountsMap.value[cinema.id]
  return list && list.length ? list : [null]
}

function isEnabled(acc) {
  return Number(acc?.status) === 1
}

/** token 是否有效：服务端 tokenStatus 0 无效 / 1 有效（token 过期或抓包失败会被 worker 置 0） */
function isValid(acc) {
  return Number(acc?.tokenStatus) === 1
}

function countOf(cinema) {
  return accountsMap.value[cinema.id]?.length || 0
}

function metaText(cinema) {
  const n = countOf(cinema)
  if (n) return `${n} 个账号`
  return accountsLoading.value ? '读取中…' : '无账号'
}

/** 复制到剪贴板：file:// 下 navigator.clipboard 不可用，退回 textarea + execCommand */
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

/** 数量右边的复制按钮：复制的是影城名称，不是账号列表 */
async function copyCinemaName(cinema) {
  const name = String(cinema?.name || '').trim()
  if (!name) {
    ElMessage.warning('该影城没有名称')
    return
  }
  const ok = await writeClipboard(name)
  if (ok) ElMessage.success(`复制 ${name} 成功`)
  else ElMessage.warning('剪贴板不可用，请检查系统权限')
}

/** 账号行右侧的复制：复制该行的出票账号 */
async function copyAccountId(acc) {
  const accountId = String(acc?.accountId || '').trim()
  if (!accountId) {
    ElMessage.warning('该账号没有账号名')
    return
  }
  const ok = await writeClipboard(accountId)
  if (ok) ElMessage.success(`复制 ${accountId} 成功`)
  else ElMessage.warning('剪贴板不可用，请检查系统权限')
}

/** 出票程序接入方式的展示文案（归一化见 typeOf） */
function typeText(cinema) {
  const t = typeOf(cinema)
  if (t === 'h5') return 'H5'
  if (t === 'miniapp') return '小程序'
  return cinema?.accessType || cinema?.protocol || '—'
}

function priorityText(acc) {
  const p = Number(acc?.priority || 0)
  if (!p) return ''
  return p === 1 ? '首选' : `#${p}`
}

async function loadTree() {
  loading.value = true
  error.value = ''
  try {
    const res = await invoke('cinemas:tree')
    if (!res?.ok) {
      error.value = res?.message || '加载失败'
      tree.value = []
      return
    }
    tree.value = res.tree || []
    // 新数据源把账号挂在程序上，树里已经带下来了：一次性灌进 accountsMap，
    // 避免几百个程序各走一次 IPC（也避免逐条响应触发整表重渲染）
    const seeded = {}
    for (const group of tree.value) {
      for (const node of group.children || []) {
        if (Array.isArray(node.accounts)) seeded[node.id] = node.accounts
      }
    }
    if (Object.keys(seeded).length) accountsMap.value = seeded
    if (!tree.value.some((s) => s.id === activeSystemId.value)) {
      activeSystemId.value = tree.value[0]?.id || 0
    }
  } catch (e) {
    error.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

/** 按影城批量拉账号，限 4 并发——影城多的时候不要一次打爆服务端 */
async function loadAccounts(list) {
  const pending = list.filter((c) => !accountsMap.value[c.id])
  if (!pending.length) return
  accountsLoading.value = true
  const next = { ...accountsMap.value }
  const queue = [...pending]
  const worker = async () => {
    while (queue.length) {
      const cinema = queue.shift()
      try {
        const res = await invoke('cinemas:accounts', { cinemaGroupId: cinema.id })
        next[cinema.id] = res?.ok ? res.lists || [] : []
      } catch {
        next[cinema.id] = []
      }
      accountsMap.value = { ...next }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  accountsLoading.value = false
}

async function openParam(cinema) {
  dialogCinema.value = cinema
  // 每次打开都是「这次抓到的」，不要把上一家的值带过来
  paramValues.value = {}
  paramDialog.value = true
}

function openDetail(cinema) {
  dialogCinema.value = cinema
  detailDialog.value = true
}

const dialogAccounts = computed(() => (dialogCinema.value ? rowsOf(dialogCinema.value) : []))

/**
 * captureConfig 是「抓包字段清单」：`[{ label: '手机号', key: 'mobile', required: true }]`。
 * 表里给运营看的是 label（手机号），抓包按 key（mobile）去匹配，两者都得留着。
 */
const dialogParamRows = computed(() => {
  const cfg = dialogCinema.value?.captureConfig
  if (!cfg || typeof cfg !== 'object') return []

  const list = Array.isArray(cfg) ? cfg : Array.isArray(cfg.fields) ? cfg.fields : null
  if (list) {
    return list
      .filter((item) => item && typeof item === 'object')
      .map((item, i) => {
        const key = String(item.key || item.label || `参数${i + 1}`)
        return {
          key,
          label: String(item.label || key),
          required: typeof item.required === 'boolean' ? item.required : null
        }
      })
  }

  // 兜底：普通键值对象，字段名就是它的 key，没有 label
  return Object.keys(cfg).map((key) => ({ key, label: key, required: null }))
})

/** 抓包拿到的值，key → value；打开弹窗时清空，点「获取参数」才填 */
const paramValues = ref({})
const capturing = ref(false)

async function captureParams() {
  const cinema = dialogCinema.value
  if (!cinema) return
  const keys = dialogParamRows.value.map((row) => row.key)
  if (!keys.length) {
    ElMessage.warning('该影城没有配置抓包参数')
    return
  }

  capturing.value = true
  try {
    const res = await invoke('cinemas:capture-params', {
      keys,
      systemCode: cinema.systemCode || '',
      waitMs: 25000
    })
    if (!res?.ok) {
      ElMessage.error(res?.message || '获取失败')
      return
    }
    const values = res.values || {}
    paramValues.value = { ...paramValues.value, ...values }
    const got = Object.keys(values).length
    if (!got) {
      ElMessage.warning('这次没有抓到数据，请在「抓包日志」里确认有该系统的请求')
    } else if (res.missing?.length) {
      ElMessage.warning(`已获取 ${got} 个参数，${res.missing.length} 个还没抓到`)
    } else {
      ElMessage.success(`已获取 ${got} 个参数`)
    }
  } catch (e) {
    ElMessage.error(e.message || '获取失败')
  } finally {
    capturing.value = false
  }
}

/** 提示里用 label（手机号），不要甩出 key（mobile）——页面上给人看的是前者
 *  还没抓到值时也能复制，退回复制参数名称，不留一个点不动的按钮 */
async function copyParam(row) {
  const text = paramValues.value[row.key] || row.label
  const ok = await writeClipboard(text)
  if (ok) ElMessage.success(`复制 ${row.label} 成功`)
  else ElMessage.warning('剪贴板不可用，请检查系统权限')
}

watch(activeSystemId, () => {
  if (cinemas.value.length) loadAccounts(cinemas.value)
})

/**
 * 底部状态栏要显示当前系统的规模。数据本来就只在这里加载，
 * 算完顺手写进 store，别让状态栏自己再拉一遍 tree + 账号。
 */
watch(
  [cinemas, totalAccounts],
  ([list, accounts]) => setCinemaStats(list.length, accounts),
  { immediate: true }
)

/** 拉树 + 当前系统的账号（登录成功、刷新都走这里） */
async function reload() {
  await loadTree()
  if (cinemas.value.length) await loadAccounts(cinemas.value)
}

/** 手动刷新：账号缓存一并作废，防止看到旧的账号列表 */
async function refreshAll() {
  accountsMap.value = {}
  await reload()
}

/** 重置筛选：三个条件一起回到默认，已加载的数据不动（要重拉数据用「刷新」） */
function resetFilters() {
  accountFilter.value = ''
  typeFilter.value = ''
  keyword.value = ''
}

onMounted(async () => {
  await loadAuth()
  if (auth.loggedIn) await reload()
})
</script>

<template>
  <div class="cinemas">
    <div class="head">
      <h1 class="head-title">影城账号</h1>
      <div class="head-actions">
        <el-select
          v-model="accountFilter"
          size="small"
          placeholder="账号"
          class="type-filter"
        >
          <el-option label="全部影城" value="" />
          <el-option label="已有账号" value="has" />
          <el-option label="未配置账号" value="none" />
        </el-select>
        <el-select v-model="typeFilter" size="small" placeholder="类型" class="type-filter">
          <el-option label="全部类型" value="" />
          <el-option label="H5" value="h5" />
          <el-option label="小程序" value="miniapp" />
        </el-select>
        <el-input
          v-model="keyword"
          size="small"
          placeholder="搜索影城"
          clearable
          class="search"
        />
        <el-button size="small" type="primary" @click="refreshAll">刷新</el-button>
        <el-button size="small" :disabled="!hasFilter" @click="resetFilters">重置</el-button>
      </div>
    </div>

    <!-- 未登录 -->
    <div v-if="!auth.loggedIn" class="placeholder">
      <div class="placeholder-text">请先登录账号</div>
      <el-button size="small" type="primary" @click="loginOpen = true">登录</el-button>
    </div>

    <template v-else>
      <div v-if="error" class="placeholder">
        <div class="placeholder-text err">{{ error }}</div>
        <el-button size="small" @click="reload">重试</el-button>
      </div>

      <div v-else-if="loading" class="placeholder">
        <div class="placeholder-text">加载中…</div>
      </div>

      <div v-else-if="!tree.length" class="placeholder">
        <div class="placeholder-text">该账号下没有可用的出票系统</div>
      </div>

      <div v-else class="split">
        <!-- 左：出票系统 -->
        <aside class="systems">
          <div class="systems-title">
            出票系统<span class="sys-total">{{ tree.length }}</span>
          </div>
          <div class="sys-list">
            <div
              v-for="sys in tree"
              :key="sys.id"
              class="sys-item"
              :class="{ active: sys.id === activeSystemId }"
              role="button"
              tabindex="0"
              @click="activeSystemId = sys.id"
              @keyup.enter="activeSystemId = sys.id"
            >
              <span class="sys-name">{{ sys.name }}</span>
              <span class="sys-count">{{ sys.children?.length || 0 }}</span>
            </div>
          </div>
          <div class="systems-foot">
            共 {{ cinemas.length }} 个程序 · {{ totalAccounts }} 个账号
          </div>
        </aside>

        <!-- 右：影城表 -->
        <div class="table-wrap">
          <table>
            <colgroup>
              <col v-for="(w, i) in COLS" :key="i" :style="{ width: w }" />
            </colgroup>
            <thead>
              <tr>
                <th>影城</th>
                <th class="center-head">类型</th>
                <th class="center-head">出票账号</th>
                <th class="center-head">状态</th>
                <th class="center-head">账号</th>
                <th class="center-head">操作</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="cinema in filteredCinemas" :key="cinema.id">
                <tr v-for="(acc, idx) in rowsOf(cinema)" :key="`${cinema.id}-${idx}`">
                  <td v-if="idx === 0" :rowspan="rowsOf(cinema).length" class="cinema-cell">
                    <div class="cinema-name" :title="cinema.name">{{ cinema.name }}</div>
                    <div class="cinema-meta">
                      <span>{{ metaText(cinema) }}</span>
                      <button
                        class="copy-btn"
                        type="button"
                        title="复制影城名称"
                        aria-label="复制影城名称"
                        @click="copyCinemaName(cinema)"
                      >
                        <CopyIcon />
                      </button>
                    </div>
                  </td>

                  <td v-if="idx === 0" :rowspan="rowsOf(cinema).length" class="type-cell">
                    {{ typeText(cinema) }}
                  </td>

                  <td class="acc-cell">
                    <div v-if="acc" class="acc">
                      <span class="acc-id mono">{{ acc.accountId || '未命名账号' }}</span>
                      <button
                        v-if="acc.accountId"
                        class="copy-btn"
                        type="button"
                        title="复制账号"
                        aria-label="复制账号"
                        @click="copyAccountId(acc)"
                      >
                        <CopyIcon />
                      </button>
                    </div>
                    <span v-else class="empty-cell">
                      {{ accountsLoading ? '读取中…' : '未配置出票账号' }}
                    </span>
                  </td>

                  <td class="st-cell">
                    <span v-if="acc" class="pill" :class="isEnabled(acc) ? 'ok' : ''">
                      {{ isEnabled(acc) ? '启用' : '停用' }}
                    </span>
                    <span v-else class="dim">—</span>
                  </td>

                  <td class="valid-cell">
                    <span v-if="acc" class="pill" :class="isValid(acc) ? 'ok' : 'err'">
                      {{ isValid(acc) ? '有效' : '无效' }}
                    </span>
                    <span v-else class="dim">—</span>
                  </td>

                  <td v-if="idx === 0" :rowspan="rowsOf(cinema).length" class="op-cell">
                    <button class="op-link" @click="openParam(cinema)">参数</button>
                    <button class="op-link" @click="openDetail(cinema)">详情</button>
                  </td>
                </tr>
              </template>

              <tr v-if="!filteredCinemas.length">
                <td colspan="6" class="no-result">
                  {{ cinemas.length ? '没有匹配的影城' : '该系统下暂无影城' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <LoginDialog v-model="loginOpen" @success="reload" />

    <!-- 参数：只留采集参数表，影城信息挪到标题里，省掉六行占位 -->
    <el-dialog
      v-model="paramDialog"
      :title="dialogCinema ? `影城参数 · ${dialogCinema.name}` : '影城参数'"
      width="600px"
      align-center
    >
      <div v-if="dialogCinema" class="dlg">
        <div v-if="dialogParamRows.length" class="param-wrap">
          <table class="param-table">
            <thead>
              <tr>
                <th class="p-name">参数名称</th>
                <th>参数值</th>
                <th class="p-required">是否必填</th>
                <th class="p-op-head">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in dialogParamRows" :key="row.key">
                <td :title="row.label">{{ row.label }}</td>
                <td class="mono p-val" :title="paramValues[row.key] || ''">
                  <span v-if="paramValues[row.key]">{{ paramValues[row.key] }}</span>
                  <span v-else class="dim">—</span>
                </td>
                <td class="p-required">
                  <span v-if="row.required === true" class="p-yes">是</span>
                  <span v-else-if="row.required === false" class="dim">否</span>
                  <span v-else class="dim">—</span>
                </td>
                <td class="p-op">
                  <button class="op-link" @click="copyParam(row)">复制</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty-cell">该影城没有额外的采集参数</div>
        <div v-if="capturing" class="p-hint">
          正在抓包，请在该系统的 H5 / 小程序里登录一次，抓到值会自动回填…
        </div>
      </div>

      <template #footer>
        <el-button size="small" @click="paramDialog = false">取消</el-button>
        <el-button size="small" type="primary" :loading="capturing" @click="captureParams">
          获取参数
        </el-button>
      </template>
    </el-dialog>

    <!-- 详情 -->
    <el-dialog v-model="detailDialog" title="影城详情" width="560px" align-center>
      <div v-if="dialogCinema" class="dlg">
        <div class="dlg-row"><span class="k">影城</span><span class="v">{{ dialogCinema.name }}</span></div>
        <div class="dlg-row"><span class="k">编码</span><span class="v mono">{{ dialogCinema.code || '—' }}</span></div>

        <div class="dlg-block">
          <div class="k">出票账号</div>
          <table class="mini">
            <thead>
              <tr>
                <th>账号</th>
                <th>优先</th>
                <th>状态</th>
                <th>会员卡</th>
                <th>优惠券</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(acc, i) in dialogAccounts" :key="i">
                <td class="mono">{{ acc?.accountId || '—' }}</td>
                <td>{{ priorityText(acc) || '—' }}</td>
                <td>{{ acc ? (isEnabled(acc) ? '启用' : '停用') : '—' }}</td>
                <td>{{ acc?.memberCardCount ?? '—' }}</td>
                <td>{{ acc?.couponCount ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.cinemas {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 22px 0 0;
  /* 冷白底：白卡片浮在上面，是后台那套观感的来源 */
  background: var(--bg-page);
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

/* 只收敛筛选栏里的相邻按钮：外层已有 gap，别再叠一层 Element 默认的 12px
   不加限定会把弹窗底部的「取消 / 获取参数」也压成 0 间距 */
.head-actions .el-button+.el-button {
  margin-left: 0;
}

.search {
  width: 200px;
}

.type-filter {
  width: 110px;
}

/* ---- 空态 ---- */
.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding-bottom: 60px;
}

.placeholder-text {
  font-size: 12.5px;
  color: var(--tx-3);
}

.placeholder-text.err {
  color: var(--err);
}

/* ---- 左右分栏 ---- */
.split {
  flex: 1;
  min-height: 0;
  display: flex;
}

.systems {
  width: 190px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 0 10px 16px 16px;
  background: var(--bg);
  border-right: 1px solid var(--line);
}

.systems-title {
  flex-shrink: 0;
  padding: 0 8px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--tx-4);
}

/* 标题后的系统数量：跟标题同级、只轻一档，别抢成标题 */
.sys-total {
  margin-left: 5px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

/* 系统可能有三十多个：列表自己滚，标题和底部统计固定 */
.sys-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin-right: -4px;
  padding-right: 4px;
}

.sys-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius);
  font-size: 12px;
  color: var(--tx-2);
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}

.sys-item:hover {
  background: var(--bg-hover);
  color: var(--tx);
}

.sys-item.active {
  background: var(--accent-bg);
  color: var(--accent);
  font-weight: 500;
  box-shadow: inset 2px 0 0 var(--accent);
}

.sys-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sys-count {
  font-size: 11px;
  color: var(--tx-4);
  font-variant-numeric: tabular-nums;
}

.sys-item.active .sys-count {
  color: var(--accent);
  opacity: 0.75;
}

.systems-foot {
  flex-shrink: 0;
  margin-top: 8px;
  padding: 8px 8px 0;
  border-top: 1px solid var(--line-soft);
  font-size: 10.5px;
  color: var(--tx-4);
}

/* ---- 表格 ---- */
.table-wrap {
  flex: 1;
  min-width: 0;
  overflow: auto;
  /* 左侧留 16px：表格有了外框，不能贴着左栏的分隔线 */
  padding: 0 26px 16px 16px;
}

/* 单元格画完整网格：纵向线把「账号 / 状态」逐行框住，横向线在 rowspan 区块里也不会断在半截。
   用 separate + border-spacing:0（而不是 collapse），否则 sticky 表头的边框会在滚动时被留在原处。 */
table {
  width: 100%;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
  /* 表格自己撑一块白底，页面底色（冷白）只在四周露出来 */
  background: var(--bg);
  border-top: 1px solid var(--line);
  border-left: 1px solid var(--line);
}

thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 30px;
  padding: 0 10px;
  text-align: left;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--tx-4);
  background: var(--bg-panel);
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.center-head {
  text-align: center;
}

tbody td {
  padding: 8px 10px;
  font-size: 12.5px;
  color: var(--tx-2);
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

tbody tr:hover td {
  background: var(--bg-hover);
}

.cinema-name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--tx);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cinema-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--tx-4);
  white-space: nowrap;
}

/* 数量右边的复制按钮：默认很淡，悬停才显形，不抢影城名的视觉重心 */
.copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--tx-4);
  cursor: pointer;
  transition:
    color 0.12s ease,
    background 0.12s ease;
}

.copy-btn:hover {
  color: var(--tx);
  background: var(--bg-hover);
}

.copy-btn svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.type-cell {
  font-size: 12px;
  color: var(--tx-3);
  text-align: center;
}

.acc {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 20px;
}

.acc-id {
  font-size: 12px;
  color: var(--tx);
}

.empty-cell {
  font-size: 12px;
  color: var(--tx-4);
}

.dim {
  color: var(--tx-4);
}

.no-result {
  text-align: center;
  padding: 26px 0 !important;
  font-size: 12px;
  color: var(--tx-4);
}

/* ---- 状态 / 账号 / 操作：标签与控件一律居中，空值也居中，不往左挤 ---- */
.st-cell,
.valid-cell {
  text-align: center;
  /* 标签列只放一个 tag，左右各留 10px 会把列撑到刚好截断，收到 6px */
  padding-left: 6px;
  padding-right: 6px;
}

.op-cell {
  text-align: center;
}

.op-link {
  padding: 0;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 11.5px;
  line-height: 18px;
  color: var(--tx-2);
  cursor: pointer;
}

.op-link + .op-link {
  margin-left: 10px;
}

.op-link:hover {
  color: var(--accent);
}

/* ---- 弹窗 ---- */
.dlg {
  font-size: 12.5px;
}

.dlg-row {
  display: flex;
  gap: 12px;
  padding: 5px 0;
}

.dlg-row .k {
  width: 56px;
  flex-shrink: 0;
  color: var(--tx-4);
}

.dlg-row .v {
  color: var(--tx);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dlg-block {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line-soft);
}

.dlg-block .k {
  font-size: 11.5px;
  color: var(--tx-4);
}

/* 采集参数表：沿用主表的网格线，列宽跟着内容走，
   单个值给个上限，太长的 token 类内容截断，靠 title 看全文 */
.param-wrap {
  max-height: 300px;
  overflow: auto;
}

.param-table {
  table-layout: auto;
}

.param-table thead th {
  height: 24px;
  font-size: 11px;
}

.param-table th.p-name {
  width: 30%;
}

.param-table th.p-required {
  width: 64px;
}

.param-table th.p-op-head {
  width: 52px;
}

.param-table tbody td {
  padding: 6px 8px;
  font-size: 11.5px;
  max-width: 240px;
}

.p-val {
  color: var(--tx);
}

/* 必填的「是」给正文色，否 / 未标注压淡——一眼能看出哪些字段不能漏 */
.p-yes {
  color: var(--tx);
}

.p-op-head,
.p-op,
.p-required {
  text-align: center;
}

/* 抓包进行中的提示，放在表格下面，别挤进表格里 */
.p-hint {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--tx-4);
}

.mini {
  width: 100%;
  margin-top: 8px;
  border-collapse: collapse;
}

.mini th {
  padding: 0 8px 6px;
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: var(--tx-4);
  border-bottom: 1px solid var(--line);
}

.mini td {
  padding: 7px 8px;
  font-size: 12px;
  color: var(--tx-2);
  border-bottom: 1px solid var(--line-soft);
}
</style>
