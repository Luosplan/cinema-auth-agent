<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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

/**
 * 当前系统的表格行：主进程已按「一行一个影城」摊开。
 * 一个连锁程序一套账号管多家影城（重明鸟3.0 管骏维、中影数字两家），
 * 只在程序维度列就会少行，跟后台对不上。
 */
const cinemas = computed(() => activeSystem.value?.children || [])

/** 归一化接入方式：accessType 是 h5 / miniapp（服务端可能给 mini），个别数据只有 protocol */
function typeOf(cinema) {
  const raw = String(cinema?.accessType || cinema?.protocol || '').toLowerCase()
  if (raw === 'h5') return 'h5'
  if (raw === 'miniapp' || raw === 'mini' || raw === 'miniprogram' || raw === 'wx') return 'miniapp'
  return ''
}

const filteredCinemas = computed(() => {
  // 影城名和程序名都能搜：运营嘴上说的是「沈阳正播」这种程序名
  const kw = keyword.value.trim().toLowerCase()
  return cinemas.value.filter((c) => {
    if (typeFilter.value && typeOf(c) !== typeFilter.value) return false
    const n = accountsMap.value[c.id]?.length || 0
    if (accountFilter.value === 'has' && !n) return false
    if (accountFilter.value === 'none' && n) return false
    if (!kw) return true
    return `${c.displayName || ''} ${c.programName || ''}`.toLowerCase().includes(kw)
  })
})

/** 有没有生效中的筛选条件：没有时「重置」置灰，别给一个点了没反应的按钮 */
const hasFilter = computed(
  () => !!accountFilter.value || !!typeFilter.value || !!keyword.value.trim()
)

/** 账号数按**程序**去重：摊成影城行后同一程序会出现多次，逐行相加会把共用的账号算两遍 */
const totalAccounts = computed(() => {
  const seen = new Set()
  let sum = 0
  for (const row of cinemas.value) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    sum += accountsMap.value[row.id]?.length || 0
  }
  return sum
})

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
  // 一套账号管多家影城：如实写「账号与 N 家共用」，否则同一条账号出现在两行像是配错了
  if ((cinema.sharedCount || 1) > 1) return `账号与 ${cinema.sharedCount} 家共用`
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
  const name = String(cinema?.displayName || '').trim()
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

/**
 * 参数：字段清单来自「单程序」配置接口（带 programId 才有 config_schema）。
 * 树里那份 captureConfig 是按凭证键名反推的，phone / mobile / phoneNumber 各占一行，
 * 真正要抓的 appletToken 反倒看不出是必填。
 *
 * 值不预填：参数值必须现场抓出来，拿接口里的旧值填上，运营就不会去抓了。
 */
async function openParam(cinema) {
  dialogCinema.value = cinema
  paramFields.value = []
  paramValues.value = {}
  paramAccounts.value = []
  captureReason.value = ''
  /**
   * 换一家系统就从零开始。
   *
   * 缓冲是全局的，上一家（凤凰 / 辰星 / 随映）的记录还在里面；面板轮询把解析结果
   * 回填表格时只看字段名，不看来自哪个系统 —— 同名的 mobile / token / ticket
   * 会直接填满这张表，表现成「还没点获取参数，所有必填参数都已经有了」。
   * 所以打开弹窗前先把记录清掉，顺便把解密范围换成这家系统的域名族。
   */
  await primeCaptureScope(cinema)
  paramDialog.value = true
  await loadParamFields(cinema)
}

async function loadParamFields(cinema) {
  paramLoading.value = true
  try {
    const res = await invoke('cinemas:param', { programId: cinema.programId || cinema.id })
    if (!res?.ok) {
      ElMessage.error(res?.message || '读取参数失败')
      return
    }
    paramFields.value = Array.isArray(res.fields) ? res.fields : []
    paramAccounts.value = Array.isArray(res.accounts) ? res.accounts : []
  } catch (e) {
    ElMessage.error(e.message || '读取参数失败')
  } finally {
    paramLoading.value = false
  }
}

/**
 * 详情：只放「这是什么程序」+「它覆盖哪些影城」。
 * 影城清单要专资号 / 地址，得回主进程再补一次（树里只有影城 id 和名字）。
 */
async function openDetail(cinema) {
  dialogCinema.value = cinema
  detailCinemas.value = []
  detailDialog.value = true
  detailLoading.value = true
  try {
    const res = await invoke('cinemas:detail', { programId: cinema.programId || cinema.id })
    if (res?.ok) detailCinemas.value = res.cinemas || []
    else ElMessage.error(res?.message || '读取影城信息失败')
  } catch (e) {
    ElMessage.error(e.message || '读取影城信息失败')
  } finally {
    detailLoading.value = false
  }
}

/** 详情弹窗的影城清单：每行 { name, standardId, city, address } */
const detailCinemas = ref([])
const detailLoading = ref(false)

/**
 * 详情表格的列：整列都没值就不显示。
 * 连锁程序动辄上百家影城，大部分没在后台登记专资号/地址，全画出来就是一屏「—」。
 */
const detailColumns = computed(() => {
  const cols = [{ key: 'name', label: '影城名称' }]
  if (detailCinemas.value.some((c) => c.standardId)) cols.push({ key: 'standardId', label: '专资号' })
  if (detailCinemas.value.some((c) => c.city)) cols.push({ key: 'city', label: '城市' })
  if (detailCinemas.value.some((c) => c.address)) cols.push({ key: 'address', label: '地址' })
  return cols
})

/** 列宽：table-layout 是 fixed，列数变了就得给一套对得上的百分比 */
const DETAIL_WIDTHS = {
  1: ['100%'],
  2: ['62%', '38%'],
  3: ['52%', '24%', '24%'],
  4: ['40%', '20%', '14%', '26%']
}

/**
 * 参数弹窗的行：`{ key, label, required, type, help }` —— **只有字段名，没有值**。
 * label 给人看，key 是抓包匹配用的字段名（applet-token / appletToken 都认），两个都得留着。
 */
const paramFields = ref([])
/** 抓包抓到的值，key → value；打开弹窗是空的，点「获取参数」才填 */
const paramValues = ref({})
/** 接口里的出票账号（一个程序可能挂多个），只取第一个用在标题和抓包系统上 */
const paramAccounts = ref([])
const paramLoading = ref(false)
const capturing = ref(false)
/** 点了停止、等主进程把已抓到的值带回来：按钮要禁用，避免连点 */
const stopping = ref(false)
/** 上一轮没抓齐时，主进程给的一句原因（没流量 / 没登录 / 字段名不同） */
const captureReason = ref('')

const paramAccountText = computed(
  () =>
    paramAccounts.value[0]?.account ||
    accountsMap.value[dialogCinema.value?.id]?.[0]?.accountId ||
    ''
)

/** 标题带上「哪个程序 + 哪套账号」：同一系统几十个程序，光看影城名容易搞混 */
const paramTitle = computed(() => {
  const cinema = dialogCinema.value
  if (!cinema) return '影城参数'
  const name = cinema.programName || cinema.name || ''
  const account = paramAccountText.value
  return account && account !== '—' ? `影城参数 · ${name}（${account}）` : `影城参数 · ${name}`
})

/**
 * 获取参数：开抓包代理，等这套系统的请求过来，按字段名回填。
 * 值的落点各家不一样（cookie / 请求头 / 请求体 / 响应体），由 pickValues 全翻一遍。
 *
 * 这一步会一直阻塞到「凑齐 / 超时 / 用户点停止」，所以界面上必须有停止的出口 ——
 * 否则用户发现字段其实已经抓到了，也只能干等剩下的几十秒。
 */
async function captureParams() {
  const cinema = dialogCinema.value
  if (!cinema) return
  const keys = paramFields.value.map((row) => row.key)
  if (!keys.length) {
    ElMessage.warning('该程序没有配置抓包参数')
    return
  }

  capturing.value = true
  captureReason.value = ''
  try {
    const res = await invoke('cinemas:capture-params', {
      keys,
      /**
       * 必填字段才决定「什么时候自动停」。
       * 会员成本 / 备注这些是人工填的，流量里永远不会出现，
       * 拿全字段当条件就只能干等满 45 秒。
       */
      requiredKeys: paramFields.value.filter((row) => row.required === true).map((row) => row.key),
      /**
       * 不再把出票账号当手机号传下去。
       *
       * 那个账号来自后台接口（程序上登记的账号），跟浏览器里登录的往往不是同一个号 ——
       * 传下去只会让主进程「抓不到手机号时用账号填」，表格里就显示成另一个号了。
       * 手机号本身在 getaccountid / getsidbytid 的响应体里，刷新页面就能抓到。
       */
      systemCode: paramAccounts.value[0]?.info?.system || cinema.systemCode || '',
      // 45 秒：够切到浏览器刷新一次、再把手机号登录走完
      waitMs: 45000
    })
    if (!res?.ok) {
      ElMessage.error(res?.message || '获取失败')
      return
    }

    const values = res.values || {}
    paramValues.value = { ...paramValues.value, ...values }
    captureReason.value = res.reason || ''
    const got = Object.keys(values).length

    /**
     * 手动停止：不是失败，已抓到的照常落表格，没抓到的保持「待抓取」。
     * 别用 warning/error 的口气，用户是自己要求停的。
     */
    if (res.stopped) {
      if (got) ElMessage.info(`已停止抓包，保留已抓到的 ${got} 个参数`)
      else ElMessage.info('已停止抓包，这次还没有抓到参数')
      return
    }

    /**
     * 必填全到手：主进程已经提前退出了等待循环（不会等满 45 秒），
     * 这里要说清「自动停了」，否则用户会以为按钮卡住。
     */
    if (res.complete) {
      ElMessage.success(`必填参数已抓齐 ${got} 个，已自动停止抓包`)
      return
    }

    if (!got) {
      ElMessage.warning(res.reason || '这次没有抓到数据，请在「抓包日志」里确认有该系统的请求')
    } else if (res.missing?.length) {
      /**
       * 手机号在账号接口（getaccountid / getsidbytid）的响应体里，不在请求头或 cookie 里。
       * 它单独没抓到时给一句可操作的话，别让人以为整个抓包都失效了。
       */
      const phoneHint = res.phoneMissing?.length ? '（手机号在接口响应里，刷新页面再抓一次）' : ''
      ElMessage.warning(
        res.reason || `已获取 ${got} 个参数，${res.missing.length} 个还没抓到${phoneHint}`
      )
    } else {
      ElMessage.success(`已获取 ${got} 个参数`)
    }
  } catch (e) {
    ElMessage.error(e.message || '获取失败')
  } finally {
    capturing.value = false
    stopping.value = false
  }
}

/**
 * 停止抓包：主进程只是置个标志，等待循环下一拍就退出并把已抓到的值带回来，
 * 所以这里不 await 结果，也不在这里改 capturing —— 由 captureParams 的 finally 统一收尾。
 */
async function stopCapture() {
  if (!capturing.value || stopping.value) return
  stopping.value = true
  try {
    await invoke('cinemas:capture-stop')
  } catch {
    stopping.value = false
  }
}

/** 抓包时直接把弹窗关掉：别让主进程还在后台等满 45 秒 */
watch(paramDialog, (open) => {
  if (!open && capturing.value) invoke('cinemas:capture-stop').catch(() => {})
})

/** 复制抓到的值；还没抓到时退回复制字段名，不留一个点不动的按钮 */
async function copyParam(row) {
  const text = String(paramValues.value[row.key] || row.key || row.label || '')
  const ok = await writeClipboard(text)
  if (ok) ElMessage.success(`复制 ${paramValues.value[row.key] ? row.label : row.key} 成功`)
  else ElMessage.warning('剪贴板不可用，请检查系统权限')
}

watch(activeSystemId, () => {
  if (cinemas.value.length) loadAccounts(cinemas.value)
})

/**
 * 底部状态栏要显示当前系统的规模。数据本来就只在这里加载，
 * 算完顺手写进 store，别让状态栏自己再拉一遍 tree + 账号。
 * 这里给的是**程序数**：children 已按影城摊开，直接用长度会把共用的影城多算一遍。
 */
watch(
  [activeSystem, totalAccounts],
  ([sys, accounts]) => setCinemaStats(sys?.programCount || 0, accounts),
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

/* ---------------- 右侧抓包面板 ---------------- */

/**
 * 把「代理到底抓到了什么、解析出了什么」直接摊在界面上。
 *
 * 以前抓不到参数只能翻日志和诊断文件，判断不了是三种里的哪一种：
 *   - 列表空、过滤数也是 0  → 代理压根没收到流量（证书 / 系统代理被别人抢了）
 *   - 过滤数很大、列表空   → 过滤规则把自己人筛掉了
 *   - 有请求但没命中字段   → 字段名和后台配置对不上，逐条看解析结果就知道差在哪
 */
/** 面板跟着参数弹窗开合，不需要单独的开关 */
const capOpen = computed(() => paramDialog.value)
const capLoading = ref(false)
const capRecords = ref([])
const capTotal = ref(0)
const capSkipped = ref(0)
/** 被过滤掉的请求（带原因）：「已过滤 N 条」要能点开核对，不能只是个数字 */
const capSkippedItems = ref([])
const capProxyRunning = ref(false)
/** 端口真的在监听吗：proxyRunning 只是内存标志，端口未必连得上 */
const capListening = ref(false)
const capFocus = ref([])
/** 本次抓包用的系统代号：和内置域名表对不上时，解密范围会是空的，得把它亮出来 */
const capSystemCode = ref('')
/**
 * 路径特征（mini 的 miniticket）。
 *
 * 有些系统的域名不固定（各影院独立域名），只锁域名族会漏人，
 * 所以抓包时另外按路径认。面板要把这件事显示出来，
 * 否则「解密范围只写了 xcxyyww.cn」会让人以为别家域名不会被抓到。
 */
const capHints = ref([])
const capMerged = ref({})
/** CONNECT 层计数：区分「流量没到」/「全被直通」/「解密了但被过滤」的唯一依据 */
const capStats = ref({ total: 0, intercepted: 0, tunneled: 0, skipped: 0, failed: 0 })
/** 实际被直通的域名：目标系统出现在这里，就是解密范围配错了 */
const capTunneled = ref([])
let capTimer = null

/** 没打开参数弹窗时，用这套常见字段名去试解析（覆盖凤凰 / 辰星 / 微信系） */
const CAP_FALLBACK_KEYS = [
  'phone',
  'mobile',
  'tid',
  'larkSid',
  '_m_h5_tk',
  '_m_h5_tk_enc',
  'token',
  'accessToken',
  'sid',
  'appletToken',
  'cookie'
]

/**
 * 手工字段：不是从流量里抓的，算进分母会让「已解析」永远差几个，看起来像抓包不给力。
 * 用**包含**判断而不是整串相等 —— 后台的写法五花八门（会员成本 / 会员成本折扣 / 影院备注…），
 * 要求整串匹配必然漏掉一批。规则与主进程 router 里的 isManualField 保持一致。
 */
const MANUAL_FIELD_RE = /备注|说明|成本|折扣|note|remark|memo|comment|discount|cost|fee|price/i

const capKeys = computed(() => {
  // 手工字段直接剔掉：它们不从流量里来，留在分母里会让「已解析」永远差几个，
  // 看起来像抓包不给力。规则与主进程 router 里的 isManualField 保持一致。
  const fromDialog = paramFields.value
    .map((row) => row.key)
    .filter((key) => key && !MANUAL_FIELD_RE.test(String(key).trim()))
  return fromDialog.length ? fromDialog : CAP_FALLBACK_KEYS
})

/**
 * 「解密范围」那一行的悬浮说明。
 *
 * mini 这类系统的域名不固定（各影院独立域名），只显示一个域名族会让人以为
 * 别家影城的流量不会被抓到 —— 把「另外按路径认」这件事写进 title 里。
 */
const capScopeTitle = computed(() => {
  const base = capFocus.value.length
    ? capFocus.value.join('、')
    : `系统代号：${capSystemCode.value || '（空）'}`
  if (!capHints.value.length) return base
  return (
    `${base}\n这套系统的域名不固定（各影院独立域名），` +
    `路径里带 ${capHints.value.join('、')} 的请求同样算，` +
    '抓到第一条就把它并进范围（如 /MiniTicket/index.php）'
  )
})

/**
 * 空列表时的分诊结论。
 *
 * 「一条都没有」有三种完全不同的原因，处理办法也完全不同，所以这里按
 * CONNECT 层的连接数把话说死，不要让人自己去猜：
 *   total=0            → 流量没走系统代理（Clash 抢了 / 浏览器用了独立代理）
 *   intercepted=0      → 收到了但全隧道直通，域名族对不上
 *   skipped 很多       → 解密了，但全是 OPTIONS / 静态资源
 */
const capHint = computed(() => {
  if (!capProxyRunning.value) return '抓包代理没在运行 —— 点「获取参数」会自动启动它'
  if (!capListening.value) {
    return '代理标志是「运行中」，但本机端口连不上 —— 端口被别的程序占了或代理进程异常，先停掉采集再重新开始'
  }
  const s = capStats.value
  const scope = capFocus.value.join('、') || '未锁定'
  if (s.total === 0) {
    return (
      '代理一条连接都没收到，说明浏览器流量没走系统代理。' +
      '检查 Clash / V2Ray 的「系统代理」开关是否被打开（它会抢回注册表），' +
      '浏览器是否用了独立代理（SwitchyOmega、Firefox 单独设置）；' +
      '如果链接是在微信内置浏览器或小程序里打开的，那种环境有的不认系统代理，改用 Chrome / Edge 打开试试'
    )
  }
  if (s.intercepted === 0) {
    if (!capFocus.value.length) {
      return (
        `这套系统没有内置解密域名（系统代号：${capSystemCode.value || '空'}），` +
        `刚才那一轮已经结束，所以这 ${s.total} 条连接都没解密。` +
        '重新点一次「获取参数」再刷新页面；若仍抓不到，把下面「直通域名」里属于目标系统的域名发我，我加进域名表'
      )
    }
    return (
      `收到 ${s.total} 条连接但全部隧道直通，没有一条需要解密。` +
      `展开下面「直通域名」核对一下：目标系统的接口域名如果在里面，说明解密范围（当前：${scope}）没覆盖到它`
    )
  }
  if (s.skipped > 0) {
    return (
      `已解密 ${s.intercepted} 条连接，其中 ${s.skipped} 条是预检 / 静态资源被过滤，还没等到接口请求。` +
      '在浏览器里刷新目标页面，并确认当前是已登录状态'
    )
  }
  return `已解密 ${s.intercepted} 条连接但一条都没记下来 —— 这是记录层的异常，请把这段现象反馈一下`
})

async function refreshCaptures() {
  if (!capOpen.value) return
  capLoading.value = true
  try {
    const res = await invoke('captures:inspect', { keys: capKeys.value, limit: 60 })
    if (!res?.ok) return
    capRecords.value = res.records || []
    capTotal.value = res.total || 0
    capSkipped.value = res.skipped || 0
    capSkippedItems.value = res.skippedItems || []
    capProxyRunning.value = Boolean(res.proxyRunning)
    capListening.value = Boolean(res.proxyListening)
    capFocus.value = res.focus || []
    capSystemCode.value = res.systemCode || ''
    capHints.value = Array.isArray(res.pathHints) ? res.pathHints : []
    capMerged.value = res.merged || {}
    if (res.stats) capStats.value = res.stats
    capTunneled.value = res.tunneledHosts || []
    /**
     * 把面板解析出的值回填到左侧表格。
     *
     * 抓包窗口结束后代理仍在解密（解密范围保留），用户晚一点刷新页面也能补上，
     * 不必再点一次「获取参数」——否则会出现「面板里有值、表格里全是待抓取」的割裂感。
     */
    for (const [key, value] of Object.entries(capMerged.value)) {
      if (value) paramValues.value[key] = value
    }
    // 已经有值进来了，上一轮「没收到任何请求」那句结论就不再成立，留着会自相矛盾
    if (Object.keys(capMerged.value).length) captureReason.value = ''
  } catch {
    /* 面板是辅助信息，读失败不打断主流程 */
  } finally {
    capLoading.value = false
  }
}

/** 面板上所有「这一轮」的计数与明细：清空记录和换系统都要整组复位，否则数字互相打架 */
function clearCaptureView() {
  capRecords.value = []
  capTotal.value = 0
  capSkipped.value = 0
  capSkippedItems.value = []
  capMerged.value = {}
  capStats.value = { total: 0, intercepted: 0, tunneled: 0, skipped: 0, failed: 0 }
  capTunneled.value = []
}

async function clearCaptures() {
  await invoke('captures:clear').catch(() => {})
  clearCaptureView()
}

/**
 * 打开参数弹窗前的准备：清记录 + 把解密范围预置成这家系统的域名族。
 *
 * 后端 `captures:clear` 带 `systemCode` 时会重算 `focusHosts` 并回传，
 * 面板「解密范围」立刻显示这家系统的域名，而不是上一家留下的（比如凤凰的 mtop）。
 */
async function primeCaptureScope(cinema) {
  const systemCode = String(cinema?.systemCode || '')
  const res = await invoke('captures:clear', { systemCode }).catch(() => null)
  clearCaptureView()
  capFocus.value = Array.isArray(res?.focus) ? res.focus : []
  capSystemCode.value = String(res?.systemCode ?? systemCode)
  capHints.value = Array.isArray(res?.pathHints) ? res.pathHints : []
}

/** 路径只留最后两段：一条 mtop 路径上百字，全画出来列表就没法看了 */
function shortPath(record) {
  const clean = String(record?.path || '').split('?')[0]
  const parts = clean.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || clean
}

/**
 * 弹窗开着就在轮询：流量是「在浏览器里刷新页面」被动产生的，
 * 没有能精确对应的事件源，只能隔一小段时间取一次。
 * 800ms 够快看出「请求进来了」，也不会把渲染线程刷爆。
 */
watch(paramDialog, (open) => {
  if (capTimer) {
    clearInterval(capTimer)
    capTimer = null
  }
  if (!open) return
  refreshCaptures()
  capTimer = setInterval(refreshCaptures, 800)
})

onUnmounted(() => {
  if (capTimer) clearInterval(capTimer)
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
            <span>出票系统</span>
            <span class="sys-total">{{ tree.length }}</span>
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
              <span class="sys-count">{{ sys.programCount || 0 }}</span>
            </div>
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
              <template v-for="cinema in filteredCinemas" :key="cinema.rowKey">
                <tr v-for="(acc, idx) in rowsOf(cinema)" :key="`${cinema.rowKey}-${idx}`">
                  <td v-if="idx === 0" :rowspan="rowsOf(cinema).length" class="cinema-cell">
                    <div class="cinema-name" :title="cinema.displayName">
                      {{ cinema.displayName }}
                    </div>
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

    <!-- 参数：只列要抓哪些字段，值留空靠抓包填 -->
    <el-dialog v-model="paramDialog" :title="paramTitle" width="980px" align-center>
      <div v-if="dialogCinema" class="dlg param-dlg">
        <div v-if="paramFields.length" class="param-wrap">
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
              <tr v-for="row in paramFields" :key="row.key">
                <td :title="row.help || row.key">
                  <div class="p-label">{{ row.label }}</div>
                </td>
                <td class="mono p-val">
                  <el-input v-model="paramValues[row.key]" size="small" placeholder="待抓取" />
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
        <div v-else class="empty-cell">
          {{ paramLoading ? '读取中…' : '该程序没有配置抓包参数' }}
        </div>
        <div v-if="capturing" class="p-hint">
          正在抓包（只解密该系统的域名，其余流量照常直通）。现在切到浏览器刷新该系统的页面并完成登录，
          抓到的值会自动回填；已经抓到了就点「停止」，不用等满时间。
        </div>
        <!-- 没抓齐时只留一句原因：没流量 / 没登录 / 字段名不同，处理办法完全不同 -->
        <div v-if="!capturing && captureReason" class="p-hint">{{ captureReason }}</div>

        <!--
          右：实时抓包面板。
          抓不到参数时这里能直接看出差在哪：没流量（列表空、过滤也 0）、
          流量被过滤（过滤数大、列表空），还是字段名对不上（有请求但没命中字段）。
        -->
        <aside class="cap-side">
          <div class="cap-head">
            <span class="cap-title">实时抓包</span>
            <!-- 端口连不上时不能还显示「抓包中」：那是标志位，不是事实 -->
            <span
              class="cap-state"
              :class="{ live: capProxyRunning && capListening, warn: capProxyRunning && !capListening }"
            >
              {{
                capProxyRunning
                  ? capListening
                    ? capturing
                      ? '抓包中'
                      : '代理已启动'
                    : '端口异常'
                  : '未启动'
              }}
            </span>
          </div>

          <div class="cap-meta">
            <div class="cap-meta-row">
              <span>解密范围</span>
              <!-- 空的时候不能只显示一个「—」：把系统代号带出来，才知道是不是代号没被认出来 -->
              <span class="cap-scope-line">
                <span
                  class="cap-scope"
                  :class="{ warn: !capFocus.length }"
                  :title="capScopeTitle"
                >
                  {{
                    capFocus.length
                      ? capFocus.join('、')
                      : capSystemCode
                        ? `未登记（${capSystemCode}）`
                        : '未锁定'
                  }}
                </span>
                <!-- 域名不固定的系统（mini）：族名之外还要靠路径认，这一截说明它不是全部 -->
                <em v-if="capHints.length" class="cap-scope-hint" :title="capScopeTitle">+路径</em>
              </span>
            </div>
            <div class="cap-meta-row">
              <span>已解析</span>
              <span>{{ Object.keys(capMerged).length }} / {{ capKeys.length }} 个字段</span>
            </div>
            <!-- 收到连接却一条都没解密 = 域名族对不上，这个数字变黄就是最直接的信号 -->
            <div class="cap-meta-row">
              <span>连接</span>
              <span
                class="cap-cnt"
                :class="{ warn: capStats.total > 0 && capStats.intercepted === 0 }"
                :title="`总连接 ${capStats.total}，其中解密 ${capStats.intercepted}、隧道直通 ${capStats.tunneled}`"
              >
                {{ capStats.total }} 总 · {{ capStats.intercepted }} 解密 ·
                {{ capStats.tunneled }} 直通
              </span>
            </div>
            <div class="cap-meta-row">
              <span>请求 / 已过滤</span>
              <span>{{ capRecords.length }} / {{ capSkipped }}</span>
            </div>
          </div>

          <div class="cap-list">
            <div v-for="rec in capRecords" :key="rec.id" class="cap-item" :class="{ hit: rec.hit }">
              <div class="cap-line">
                <span class="cap-method">{{ rec.method }}</span>
                <span class="cap-path" :title="rec.path">{{ shortPath(rec) }}</span>
                <span class="cap-code" :class="{ bad: rec.statusCode >= 400 }">
                  {{ rec.statusCode }}
                </span>
                <!-- 响应体 0B：说明报文没拿到，不是字段名的问题 -->
                <span class="cap-bytes" :class="{ bad: !rec.bodyLen }" :title="`响应体 ${rec.bodyLen} 字符`">
                  {{ rec.bodyLen ? `${rec.bodyLen}B` : '0B' }}
                </span>
              </div>
              <div v-if="rec.hit" class="cap-fields">
                <span v-for="(v, k) in rec.params" :key="k" class="cap-chip" :title="`${k} = ${v}`">
                  {{ k }}
                </span>
              </div>
              <div v-else class="cap-miss">没有目标字段</div>
            </div>

            <div v-if="!capRecords.length" class="cap-empty">{{ capHint }}</div>
          </div>

          <!--
            直通域名：这是「一条请求都没有」时最有价值的一块。
            浏览器实际连了哪些域名、各几次，全在这里；目标系统的域名一旦出现，
            就直接说明解密范围没覆盖到它 —— 不用再猜是不是代理没生效。
          -->
          <details v-if="capTunneled.length" class="cap-skipped">
            <summary>直通域名（{{ capTunneled.length }} 个）</summary>
            <div v-for="t in capTunneled" :key="t.host" class="cap-skip">
              <span class="cap-path" :title="t.host">{{ t.host }}</span>
              <span class="cap-reason">{{ t.count }} 次</span>
            </div>
          </details>

          <details v-if="capSkippedItems.length" class="cap-skipped">
            <summary>已过滤的请求（最近 {{ capSkippedItems.length }} 条）</summary>
            <div v-for="(s, i) in capSkippedItems" :key="i" class="cap-skip">
              <span class="cap-method">{{ s.method }}</span>
              <span class="cap-path" :title="s.path">{{ shortPath(s) }}</span>
              <span class="cap-reason">{{ s.reason }}</span>
            </div>
          </details>

          <div class="cap-foot">
            <button class="op-link" type="button" @click="clearCaptures">清空记录</button>
          </div>
        </aside>
      </div>

      <template #footer>
        <el-button size="small" @click="paramDialog = false">关闭</el-button>
        <!-- 抓包是个长阻塞动作，必须给出中途退出的口子，停完保住已抓到的值 -->
        <el-button
          v-if="capturing"
          size="small"
          type="danger"
          plain
          :loading="stopping"
          @click="stopCapture"
        >
          停止
        </el-button>
        <el-button size="small" type="primary" :loading="capturing" @click="captureParams">
          获取参数
        </el-button>
      </template>
    </el-dialog>

    <!-- 详情：程序是谁 + 它覆盖哪些影城（账号的事在上面的参数弹窗/主表里，不在这里重复） -->
    <el-dialog v-model="detailDialog" title="详情" width="640px" align-center>
      <div v-if="dialogCinema" class="dlg">
        <div class="dlg-row">
          <span class="k">名称</span>
          <span class="v">{{ dialogCinema.name || '—' }}</span>
        </div>
        <div class="dlg-row">
          <span class="k">系统</span>
          <span class="v">{{ activeSystem?.name || dialogCinema.systemCode || '—' }}</span>
        </div>

        <div class="dlg-block">
          <div class="k">影城 {{ detailCinemas.length ? `（${detailCinemas.length}）` : '' }}</div>
          <div class="mini-wrap">
            <table class="mini cinema-table">
              <colgroup>
                <col
                  v-for="(col, i) in detailColumns"
                  :key="col.key"
                  :style="{ width: DETAIL_WIDTHS[detailColumns.length][i] }"
                />
              </colgroup>
              <thead>
                <tr>
                  <th v-for="col in detailColumns" :key="col.key">{{ col.label }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(item, i) in detailCinemas" :key="i">
                  <td
                    v-for="col in detailColumns"
                    :key="col.key"
                    :class="{ mono: col.key === 'standardId' }"
                    :title="item[col.key] || ''"
                  >
                    {{ item[col.key] || '—' }}
                  </td>
                </tr>
                <tr v-if="!detailCinemas.length">
                  <td :colspan="detailColumns.length" class="mini-empty">
                    {{ detailLoading ? '读取中…' : '没有关联影城' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="detailCinemas.length && detailColumns.length === 1" class="mini-hint">
            这些影城在后台还没有登记专资号 / 城市 / 地址
          </div>
        </div>
      </div>

      <template #footer>
        <el-button size="small" @click="detailDialog = false">关闭</el-button>
      </template>
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
  border-right: 1px solid var(--line);
}

.systems-title {
  display: flex;
  justify-content: space-between;
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

/* ---- 参数弹窗右侧的实时抓包面板 ----
   左内容靠 padding-right 让位，面板绝对定位贴右：不动内部结构，也不需要再包一层 flex。
   min-height 保证左侧字段少时面板仍有可读高度；420 是「两条 details 都展开、
   列表还露得出两条记录」的下限，再小就只能看到滚动条了。 */
.param-dlg {
  position: relative;
  min-height: 420px;
  padding-right: 336px;
}

.cap-side {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  width: 324px;
  overflow: hidden;
  background: var(--bg-panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}

.cap-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
}

.cap-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--tx);
}

.cap-state {
  padding: 1px 7px;
  font-size: 10.5px;
  color: var(--tx-3);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 9px;
}

.cap-state.live {
  color: var(--ok);
  background: var(--ok-bg);
  border-color: transparent;
}

/* 端口连不上：标志位说在跑、实际一条流量都进不来，必须显眼 */
.cap-state.warn {
  color: var(--warn);
  background: var(--warn-bg);
  border-color: transparent;
}

.cap-meta {
  padding: 7px 10px;
  border-bottom: 1px solid var(--line-soft);
}

.cap-meta-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  line-height: 1.75;
  color: var(--tx-4);
}

.cap-scope {
  max-width: 190px;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  color: var(--tx-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 范围 + 路径标记：族名可能被省略号截断，标记必须留在省略号外面 */
.cap-scope-line {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
}

.cap-scope-hint {
  flex: 0 0 auto;
  font-size: 11px;
  font-style: normal;
  color: var(--tx-3);
  white-space: nowrap;
}

/* 解密范围为空 = 这套系统没有内置域名表，全量解密兜底或干脆没解 —— 必须显眼 */
.cap-scope.warn {
  font-family: inherit;
  font-weight: 600;
  color: var(--warn);
}

/* 连接数：数字比标签重要，用等宽字体对齐，变黄即「收到流量但没解密」 */
.cap-cnt {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--tx-3);
  white-space: nowrap;
}

.cap-cnt.warn {
  font-weight: 600;
  color: var(--warn);
}

.cap-list {
  flex: 1 1 auto;
  /* flex 项的 min-height 默认是 auto，不加这行它不肯缩到内容以下，
     两个 details 都展开时会把「清空记录」挤出面板 */
  min-height: 0;
  padding: 5px 6px;
  overflow: auto;
}

.cap-item {
  padding: 5px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
}

.cap-item + .cap-item {
  margin-top: 3px;
}

/* 命中目标字段的那条给白底+边框：一眼能认出「就是这条给了值」 */
.cap-item.hit {
  background: var(--bg);
  border-color: var(--line);
}

.cap-line {
  display: flex;
  gap: 6px;
  align-items: baseline;
}

.cap-method {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--tx-3);
}

.cap-path {
  flex: 1 1 auto;
  /* 加了响应体大小这一列之后，路径要能真正被压缩：flex 项默认 min-width:auto，
     不写这行它会撑着不缩，把状态码和字节数挤出面板 */
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--tx-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cap-code {
  font-size: 10px;
  color: var(--tx-4);
}

.cap-code.bad {
  color: var(--err);
}

/* 响应体大小：0B 标红，一眼看出「报文没拿到」和「字段对不上」的区别 */
.cap-bytes {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--tx-4);
  opacity: 0.75;
}

.cap-bytes.bad {
  font-weight: 600;
  color: var(--err);
  opacity: 1;
}

.cap-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.cap-chip {
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 16px;
  color: var(--accent);
  background: var(--accent-bg);
  border-radius: 3px;
}

.cap-miss {
  margin-top: 3px;
  font-size: 10.5px;
  color: var(--tx-4);
}

.cap-empty {
  padding: 20px 8px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--tx-4);
  text-align: center;
}

.cap-skipped {
  /* 不许被压扁：它自己带 max-height + 内部滚动，压了反而看不出有几条 */
  flex: 0 0 auto;
  max-height: 88px;
  padding: 6px 8px;
  overflow: auto;
  border-top: 1px solid var(--line-soft);
}

.cap-skipped summary {
  font-size: 11px;
  color: var(--tx-3);
  cursor: pointer;
}

.cap-skip {
  display: flex;
  gap: 6px;
  align-items: baseline;
  padding: 2px 0;
  font-size: 10.5px;
  color: var(--tx-4);
}

.cap-reason {
  color: var(--warn);
  white-space: nowrap;
}

.cap-foot {
  flex: 0 0 auto;
  padding: 6px 10px;
  text-align: right;
  border-top: 1px solid var(--line-soft);
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

/* 参数值：整列可编辑，输入框贴合表格，只有聚焦时才显出边框 */
.p-val {
  color: var(--tx);
}

.p-val :deep(.el-input__wrapper) {
  padding: 0 4px;
  background: transparent;
  box-shadow: inset 0 0 0 1px transparent;
}

.p-val :deep(.el-input__wrapper:hover) {
  box-shadow: inset 0 0 0 1px var(--line);
}

.p-val :deep(.el-input__wrapper.is-focus) {
  background: var(--bg);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.p-val :deep(.el-input__inner) {
  height: 22px;
  font-size: 11.5px;
  font-family: inherit;
  color: var(--tx);
}

/* 字段说明（怎么抓、有效期、别填旧版的哪个 token）：压淡、单行截断，靠 title 看全文 */
.p-label {
  color: var(--tx-2);
}

.p-help {
  max-width: 210px;
  margin-top: 2px;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--tx-4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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

/* 详情里的影城表：连锁程序能有一百多家，表格自己滚，弹窗别被撑到屏幕外 */
.mini-wrap {
  max-height: 320px;
  overflow: auto;
}

.cinema-table {
  table-layout: fixed;
}

.cinema-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding-top: 6px;
  background: var(--bg);
}

.cinema-table td {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mini-empty {
  padding: 18px 0 !important;
  text-align: center;
  color: var(--tx-4);
}

.mini-hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--tx-4);
}
</style>
