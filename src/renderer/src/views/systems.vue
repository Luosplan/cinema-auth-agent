<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { invoke } from '@utils/ipc'
import { auth, loadAuth } from '../stores/auth'
import LoginDialog from '../components/LoginDialog.vue'

/**
 * 影城配置：左边出票系统，右边这套系统下的影城。
 *
 * 每行能改的是「怎么打开这家影城」：
 *   - 类型（H5 / 小程序）来自后台，决定用哪套适配器，这里只读；
 *   - 入口链接 / 小程序 appId 可以按影城覆盖，保存在本机。
 * 打开顺序：本机覆盖 > 后台给这家影城配的 accessUrl > 这套程序的公共入口。
 */

const tree = ref([])
const rules = ref([])
const activeSystemId = ref(0)
const keyword = ref('')
const loading = ref(false)
const error = ref('')
const loginOpen = ref(false)

const activeSystem = computed(
  () => tree.value.find((s) => s.id === activeSystemId.value) || null
)
const cinemas = computed(() => activeSystem.value?.children || [])

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return cinemas.value
  return cinemas.value.filter((c) => String(c.name || '').toLowerCase().includes(kw))
})

/** 一套系统下所有影城共用一个抓包规则，取第一个影城的 systemCode 即可 */
const systemCode = computed(
  () => cinemas.value.find((c) => c.systemCode)?.systemCode || ''
)
const activeRule = computed(() => rules.value.find((r) => r.id === systemCode.value) || null)

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
    if (!tree.value.some((s) => s.id === activeSystemId.value)) {
      activeSystemId.value = tree.value[0]?.id || 0
    }
  } catch (e) {
    error.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function loadRules() {
  rules.value = (await invoke('rules:list')) || []
}

/* ---- 入口展示 ---- */
function typeText(cinema) {
  const raw = String(cinema?.accessType || '').toLowerCase()
  if (raw === 'h5') return 'H5'
  if (raw === 'miniapp' || raw === 'miniprogram' || raw === 'wx') return '小程序'
  return cinema?.accessType || '—'
}

function isMini(cinema) {
  return String(cinema?.accessType || '').toLowerCase() === 'miniapp'
}

function entryUrlOf(cinema) {
  return cinema?.entry?.url || cinema?.accessUrl || ''
}

function appIdOf(cinema) {
  return cinema?.entry?.appid || (isMini(cinema) ? activeRule.value?.launch?.appid || '' : '')
}

/** 本机改过就标一下，避免和后台配的入口混淆 */
function isOverridden(cinema) {
  return Boolean(cinema?.entry && (cinema.entry.url || cinema.entry.appid))
}

/* ---- 访问 / 编辑 ---- */
async function visit(cinema) {
  const res = await invoke('cinemas:entry:open', {
    systemCode: cinema.systemCode || systemCode.value,
    cinema: {
      name: cinema.name,
      accessType: cinema.accessType,
      accessUrl: cinema.accessUrl,
      entry: cinema.entry || null
    }
  })
  if (!res?.ok) ElMessage.error(res?.message || '打不开这家影城的入口')
  else if (res.hint) ElMessage.info(res.hint)
  else ElMessage.success('已打开入口')
}

const editOpen = ref(false)
const editing = ref(null)
const form = reactive({ url: '', appid: '' })

function openEdit(cinema) {
  editing.value = cinema
  form.url = entryUrlOf(cinema)
  form.appid = cinema?.entry?.appid || (isMini(cinema) ? activeRule.value?.launch?.appid || '' : '')
  editOpen.value = true
}

async function saveEntry() {
  const cinema = editing.value
  if (!cinema) return
  const res = await invoke('cinemas:entry:set', {
    cinemaGroupId: cinema.id,
    url: form.url,
    appid: isMini(cinema) ? form.appid : ''
  })
  if (!res?.ok) {
    ElMessage.error(res?.message || '保存失败')
    return
  }
  cinema.entry = res.entry || null
  editOpen.value = false
  ElMessage.success(res.entry ? '已保存到本机' : '已清空，改回使用后台配置的入口')
}

onMounted(async () => {
  await loadAuth()
  await loadRules()
  if (auth.loggedIn) await loadTree()
})
</script>

<template>
  <div class="config">
    <div class="head">
      <h1 class="head-title">影城配置</h1>
      <div class="head-actions">
        <el-input
          v-model="keyword"
          size="small"
          placeholder="搜索影城"
          clearable
          class="search"
        />
        <el-button size="small" @click="loadTree">刷新</el-button>
      </div>
    </div>

    <div v-if="!auth.loggedIn" class="placeholder">
      <div class="placeholder-text">登录会员账号后可配置各影城的入口</div>
      <el-button size="small" type="primary" @click="loginOpen = true">登录</el-button>
    </div>

    <template v-else>
      <div v-if="error" class="placeholder">
        <div class="placeholder-text err">{{ error }}</div>
        <el-button size="small" @click="loadTree">重试</el-button>
      </div>

      <div v-else-if="loading" class="placeholder">
        <div class="placeholder-text">加载中…</div>
      </div>

      <div v-else-if="!tree.length" class="placeholder">
        <div class="placeholder-text">该会员账号下没有可用的出票系统</div>
      </div>

      <div v-else class="split">
        <!-- 左：出票系统 -->
        <aside class="systems">
          <div class="systems-title">出票系统</div>
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
          <div class="systems-foot">共 {{ cinemas.length }} 家影城</div>
        </aside>

        <!-- 右：该系统下的影城 -->
        <div class="right">
          <div class="table-wrap">
            <table>
              <colgroup>
                <col style="width: 29%" />
                <col style="width: 11%" />
                <col style="width: 30%" />
                <col style="width: 15%" />
                <col style="width: 15%" />
              </colgroup>
              <thead>
                <tr>
                  <th>名称</th>
                  <th class="center-head">类型</th>
                  <th>入口链接</th>
                  <th>appId</th>
                  <th class="center-head">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="cinema in filtered" :key="cinema.id">
                  <td>
                    <div class="name-inner">
                      <span class="name" :title="cinema.name">{{ cinema.name }}</span>
                      <span v-if="isOverridden(cinema)" class="tag">本机</span>
                    </div>
                  </td>
                  <td class="center">{{ typeText(cinema) }}</td>
                  <td class="mono url" :title="entryUrlOf(cinema)">
                    <span v-if="entryUrlOf(cinema)">{{ entryUrlOf(cinema) }}</span>
                    <span v-else class="dim">未设置</span>
                  </td>
                  <td class="mono appid" :title="appIdOf(cinema)">
                    <span v-if="appIdOf(cinema)">{{ appIdOf(cinema) }}</span>
                    <span v-else class="dim">—</span>
                  </td>
                  <td class="ops">
                    <button class="op-link" @click="visit(cinema)">访问</button>
                    <button class="op-link" @click="openEdit(cinema)">编辑</button>
                  </td>
                </tr>
                <tr v-if="!filtered.length">
                  <td colspan="5" class="no-result">
                    {{ cinemas.length ? '没有匹配的影城' : '该系统下暂无影城' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>

    <LoginDialog v-model="loginOpen" @success="loadTree" />

    <!-- 编辑入口：类型由后台决定，只改「怎么打开」 -->
    <el-dialog
      v-model="editOpen"
      :title="editing ? `影城入口 · ${editing.name}` : '影城入口'"
      width="520px"
      align-center
    >
      <div v-if="editing" class="dlg">
        <div class="dlg-row">
          <span class="k">类型</span>
          <span class="v">{{ typeText(editing) }}（由后台决定，不可改）</span>
        </div>
        <div class="dlg-row">
          <span class="k">链接</span>
          <el-input
            v-model="form.url"
            size="small"
            clearable
            :placeholder="
              isMini(editing)
                ? '小程序链接 / 短链，可留空'
                : 'https://h5.example.com/ticket'
            "
          />
        </div>
        <div v-if="isMini(editing)" class="dlg-row">
          <span class="k">appId</span>
          <el-input v-model="form.appid" size="small" clearable placeholder="wx0123456789abcdef" />
        </div>
        <p class="dlg-tip">
          保存在本机，不影响后台配置。两项都留空即改回使用后台给这家影城配的入口。
          打开顺序：本机设置 → 后台入口 → 这套程序的公共入口。
        </p>
      </div>

      <template #footer>
        <el-button size="small" @click="editOpen = false">取消</el-button>
        <el-button size="small" type="primary" @click="saveEntry">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.config {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 22px 0 0;
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

.search {
  width: 200px;
}

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
  width: 176px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 0 10px 16px 16px;
  border-right: 1px solid var(--line-soft);
}

.systems-title {
  flex-shrink: 0;
  padding: 0 8px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--tx-4);
}

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
  background: var(--bg-active);
  color: var(--tx);
  font-weight: 500;
  box-shadow: inset 2px 0 0 var(--tx);
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
  color: var(--tx-3);
}

.systems-foot {
  flex-shrink: 0;
  margin-top: 8px;
  padding: 8px 8px 0;
  border-top: 1px solid var(--line-soft);
  font-size: 10.5px;
  color: var(--tx-4);
}

/* ---- 右栏 ---- */
.right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* ---- 表格 ---- */
.table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 26px 16px 16px;
}

table {
  width: 100%;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
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
  background: #fafafb;
}

.center {
  text-align: center;
}

.name-inner {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--tx);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 「本机」标记：提醒这条入口是采集端改过的，不是后台配置 */
.tag {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 16px;
  color: var(--tx-3);
  background: var(--bg-hover);
}

.url {
  font-size: 11.5px;
}

.appid {
  font-size: 11px;
}

.dim {
  color: var(--tx-4);
}

.ops {
  text-align: center;
  white-space: nowrap;
}

.op-link {
  padding: 0 4px;
  border: none;
  background: transparent;
  font-size: 12px;
  color: var(--tx-2);
  cursor: pointer;
}

.op-link + .op-link {
  margin-left: 4px;
}

.op-link:hover {
  color: var(--tx);
  text-decoration: underline;
}

.no-result {
  padding: 26px 0;
  text-align: center;
  font-size: 12px;
  color: var(--tx-4);
}

/* ---- 弹窗 ---- */
.dlg {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dlg-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dlg-row .k {
  width: 48px;
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--tx-4);
}

.dlg-row .v {
  font-size: 12px;
  color: var(--tx-2);
}

.dlg-tip {
  margin: 2px 0 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--tx-4);
}
</style>
