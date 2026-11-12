/**
 * 出票系统（ticket-server）响应 → 界面数据结构的适配层。
 *
 * 这里只做纯数据转换，不碰 electron / 网络，方便单独跑脚本验证。
 * 服务端形状见 `GET /api/ticket-program-account-configs?includeUnconfigured=1&compact=1`：
 *   { success, data: [{ program_id, name, city, system, type, account_id, account_name,
 *                       account_count, cinema_ids, cinema_id_names, cinema_count,
 *                       credentials, user_credentials, enabled, credential_status, ... }] }
 * 一行 = 一个出票程序，账号挂在程序上。
 */

/**
 * 出票系统字典（照抄后台前端的 `Fp` 常量）。
 *
 * 顺序就是左栏的展示顺序 —— 后台维护的这套顺序更像运营脑子里的顺序，
 * 比自己按字母或按数量排更稳（数量每天变，顺序会跳）。
 * 列表里有但库里暂时没数据的系统不会被渲染出来，只在有程序时才出现。
 */
export const SYSTEM_CATALOG = [
  { label: '星辰印象', value: 'xingchen-yinxiang' },
  { label: '爱电影网H5（券）', value: 'imovie-h5' },
  { label: '影伴系统', value: 'iyingban' },
  { label: '凤凰云智', value: 'phoenix' },
  { label: '凤凰云智小程序', value: 'phoenix-mini' },
  { label: '凤凰佳影', value: 'phoenix-jiaying' },
  { label: '来一票', value: 'laiyipiao' },
  { label: '奥映', value: 'oristar' },
  { label: '辰星系统', value: 'cx-family' },
  { label: 'MiniTicket系统', value: 'mini-family' },
  { label: '365系统', value: 'imovie365-family' },
  { label: '随映系统', value: 'sgycyk' },
  { label: '光影系统', value: 'guangying-family' },
  { label: '360系统', value: 'yingyuan360' },
  { label: '惠影票', value: 'huiyingpiao' },
  { label: '潘多拉系统', value: 'pandora' },
  { label: '鲸鱼系统', value: 'jingyu' },
  { label: '1905系统', value: 'movie1905' },
  { label: '影联系统', value: 'paimeng' },
  { label: '睿自由系统', value: 'ruiziyou' },
  { label: '鬣狗系统', value: 'liegou' },
  { label: '万花筒系统', value: 'wanhuatong' },
  { label: '兜有系统', value: 'douyou' },
  { label: '金淘淘系统', value: 'jintaotao' },
  { label: '乐影系统', value: 'leying' },
  { label: '重明鸟系统', value: 'chongmingniao' },
  { label: '最美系统（券）', value: 'zmax' },
  { label: '深圳纵横系统', value: 'zone-sz' },
  { label: '文创', value: 'wenchuang' },
  { label: '文投影业', value: 'wentou' },
  { label: '博纳小程序', value: 'bona-dxds' },
  { label: '映前系统', value: 'yq30' },
  { label: '卢米埃', value: 'lumiere' },
  { label: '吉木同', value: 'jmtnt' },
  { label: '重明鸟3.0', value: 'chongmingniao-v3' }
]

/**
 * 原始代号 → 字典 value（后台的 `Lp` 别名表）。
 *
 * 同一套出票系统的多个版本/分支算一类：cx-2 / cx-v1 / cx-v3 / cx-v104 / cx-middleground
 * 都归到「辰星系统」，否则左栏会被版本号切成一堆两三家的碎片。
 * 注意：只影响**分组和显示名**，程序行上的 `systemCode` 仍是原始代号 ——
 * 抓包规则是按原始 id 匹配的（`ctx.extractor.activeRules`），不能替换。
 */
export const SYSTEM_ALIASES = {
  'cx-2': 'cx-family',
  'cx-v1': 'cx-family',
  'cx-v3': 'cx-family',
  'cx-v104': 'cx-family',
  'cx-middleground': 'cx-family',
  blwh: 'cx-family',
  // 奥映跑的就是辰星的程序（运营口径：奥映是辰星的一个门面），归到一组，别单列
  oristar: 'cx-family',
  'mini-v1': 'mini-family',
  'mini-v2': 'mini-family',
  'mini-xxxshdz': 'mini-family',
  imovie365: 'imovie365-family',
  'imovie365-sdgj': 'imovie365-family',
  guoyu: 'guangying-family',
  'xiangsu-zhongying': 'guangying-family'
}

const CATALOG_LABEL = new Map(SYSTEM_CATALOG.map((item) => [item.value, item.label]))
const CATALOG_ORDER = new Map(SYSTEM_CATALOG.map((item, index) => [item.value, index]))

/** 原始代号 → 字典分组 key；查不到就小写原样返回，保证不同写法也能合并 */
export function systemKeyOf(code) {
  const raw = String(code || '').trim()
  if (!raw) return ''
  const lower = raw.toLowerCase()
  return SYSTEM_ALIASES[raw] || SYSTEM_ALIASES[lower] || lower
}

/** 分组 key → 展示名；字典里没有的直接显示原始代号，不至于空白 */
export function systemLabel(code) {
  const raw = String(code || '').trim()
  if (!raw) return '未指定系统'
  return CATALOG_LABEL.get(systemKeyOf(raw)) || raw
}

/** 左栏排序用：字典里的按下标，字典外的排最后 */
export function systemOrderOf(code) {
  const index = CATALOG_ORDER.get(systemKeyOf(code))
  return index === undefined ? Number.MAX_SAFE_INTEGER : index
}

/** credentials 里的字段名 → 中文显示名（参数弹窗第一列） */
export const CREDENTIAL_LABELS = {
  mobile: '手机号',
  phone: '手机号',
  username: '账号',
  account: '账号',
  password: '密码',
  token: '令牌',
  accessToken: '令牌',
  access_token: '令牌',
  refreshToken: '刷新令牌',
  cookie: 'Cookie',
  cookies: 'Cookie',
  userId: '用户 ID',
  cinemaId: '影城 ID',
  cinema_id: '影城 ID',
  cinemaCode: '影城编码',
  cinema_code: '影城编码',
  standardId: '专资号',
  standard_id: '专资号',
  baseUrl: '接口地址',
  base_url: '接口地址',
  appId: 'AppID',
  app_id: 'AppID',
  tenantId: '租户 ID',
  tenant_id: '租户 ID',
  channelCode: '渠道编码',
  channel_code: '渠道编码'
}

/** 服务端 credential_status：只有 'valid' 算有效，其余（expired / unknown / 空）都算无效 */
export function tokenStatusOf(status) {
  return String(status || '').toLowerCase() === 'valid' ? 1 : 0
}

/** 从 credentials 里挑一个能当「出票账号」展示的值，都没有就退回影城名 */
export function accountNameOf(credentials, fallback) {
  const c = credentials && typeof credentials === 'object' ? credentials : {}
  return String(c.mobile || c.phone || c.username || c.account || c.userId || fallback || '')
}

/**
 * credentials 是 { 字段名: 值 } 对象，界面要的是字段清单 [{ key, label, required }]。
 * 服务端没有「必填」这个概念，统一给 false。
 */
export function captureConfigOf(credentials) {
  const c = credentials && typeof credentials === 'object' ? credentials : {}
  return Object.keys(c)
    .filter((key) => c[key] !== null && c[key] !== undefined && c[key] !== '')
    .map((key) => ({ key, label: CREDENTIAL_LABELS[key] || key, required: false }))
}

/**
 * 服务端「程序账号配置」行 → 界面要的 { id, name, children[] } 两级树。
 *
 * 数据源是 `GET /api/ticket-program-account-configs?includeUnconfigured=1&compact=1`：
 * 一行 = 一个出票程序（program），一个程序可能覆盖多家影城（连锁，cinema_count > 1），
 * `account_count / account_name / credential_status` 就是这个程序下配的账号。
 * 左栏按 `system` 分组，`type` 是 h5 / mini（小程序），统一归一成界面认的 h5 / miniapp。
 */
export function accessTypeOf(row) {
  const raw = String(row?.type || row?.access_type || row?.accessType || '').toLowerCase()
  if (raw === 'h5') return 'h5'
  if (raw === 'mini' || raw === 'miniapp' || raw === 'miniprogram' || raw === 'wx') return 'miniapp'
  return raw
}

export function buildCinemaTree(rows) {
  const list = Array.isArray(rows) ? rows : []
  const groups = new Map()
  /**
   * programId → 节点：接口是「一个账号一行」，同一程序会重复出现，必须合并。
   * 停用的程序也照原样进树：后台左栏的口径是「全部程序」（凤凰云智 18 个里含 3 个停用），
   * 少算它们就会和后台对不上；这些行本来没有账号，界面按「未配置出票账号」渲染。
   */
  const nodes = new Map()
  list.forEach((row, index) => {
    /**
     * 分组以「实际跑的系统」为准，不是配置里登记的那个。
     * 例：大连麦凯乐泊林影城 `system=phoenix`，但 `runtime_system=program_key=jintaotao`，
     * 出票实际走的是金淘淘 —— 按 system 分组会把它塞进凤凰云智（用户实测反馈过）。
     */
    const systemCode = String(row.runtime_system || row.program_key || row.system || '').trim()
    // 分组按字典归并（cx-* / oristar → 辰星系统），行上的 systemCode 保留原始代号给抓包用
    const groupKey = systemKeyOf(systemCode) || 'unknown'
    const programId = Number(row.program_id ?? 0)
    // program_id 一定在；账号配置 id 只有配过账号才有，不能当主键
    const id = programId || Number(row.id ?? row.account_id ?? 0) || index + 1
    const key = `${groupKey}:${id}`

    let node = nodes.get(key)
    if (!node) {
      if (!groups.has(groupKey)) {
        groups.set(groupKey, { id: groupKey, name: systemLabel(systemCode), children: [] })
      }
      node = {
        id,
        programId,
        name: row.name || row.program_name || '',
        code: String(row.cinema_standard_ids || '').split(',')[0] || '',
        city: row.city || row.cinema_cities || '',
        systemCode,
        systemKey: groupKey,
        accessType: accessTypeOf(row),
        captureConfig: captureConfigOf(row.user_credentials || row.credentials),
        enabled: Number(row.enabled) === 1,
        accountId: row.account_name || '',
        accountCount: Number(row.account_count) || 0,
        // 账号直接随行带下去，界面不用为每个程序再走一次 IPC
        accounts: [],
        credentialStatus: row.credential_status || '',
        cinemaCount: Number(row.cinema_count) || 1,
        cinemaNames: Array.isArray(row.cinema_id_names)
          ? row.cinema_id_names.map((c) => c.name).filter(Boolean)
          : []
      }
      nodes.set(key, node)
      groups.get(groupKey).children.push(node)
    }

    // 同一程序的多行各带一个账号：按账号号去重合并，界面才能按账号铺成多行
    for (const acc of accountsOf(row)) {
      if (!node.accounts.some((item) => item.accountId === acc.accountId)) node.accounts.push(acc)
    }
    if (!node.accountId && row.account_name) node.accountId = row.account_name
    node.accountCount = Math.max(node.accountCount, node.accounts.length)
  })
  // 按字典顺序排；字典外的排最后，按程序数多的在前，免得碎片沉在列表底下看不见
  return [...groups.values()].sort(
    (a, b) => systemOrderOf(a.id) - systemOrderOf(b.id) || b.children.length - a.children.length
  )
}

/**
 * 程序覆盖的影城清单（详情弹窗那张表）。
 *
 * 服务端只给 `cinema_id_names:[{id,name}]`，专资号 / 城市 / 地址要靠 `/cinemas` 字典补。
 * 连锁程序的 `cinema_cities` 是**去过重的城市串**，跟影城一行对不上，所以只有单影城程序
 * 才拿它兜底；查不到的字段一律留空，让界面显示「—」，别硬套成别家影城的信息。
 */
export function cinemasOfProgram(row, registry) {
  if (!row) return []
  const byId = registry?.byId || new Map()
  const byName = registry?.byName || new Map()
  const items =
    Array.isArray(row.cinema_id_names) && row.cinema_id_names.length
      ? row.cinema_id_names.map((c) => ({ id: Number(c.id) || 0, name: c.name || '' }))
      : [{ id: 0, name: row.name || '' }]
  const stds = String(row.cinema_standard_ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const single = items.length === 1
  return items.map((item, index) => {
    const hit = (item.id && byId.get(item.id)) || byName.get(item.name) || null
    return {
      id: item.id || Number(hit?.id) || 0,
      name: item.name || hit?.name || '',
      // 专资号列表和影城列表等长时按位置配对，否则只能靠字典
      standardId: hit?.standard_id || (stds.length === items.length ? stds[index] : '') || '',
      city: hit?.city || (single ? row.cinema_cities || row.city || '' : '') || '',
      // 字典的 address 常为空，凭证里的登记地址能兜一层（同一家影城的地址）
      address: hit?.address || hit?.credentials?.registryCinemaAddress || ''
    }
  })
}

/**
 * 一个程序 → 0 或 1 个出票账号。
 *
 * 新数据源里账号就挂在程序上：`account_count` 为 0 表示这个程序还没配账号
 * （接口带 includeUnconfigured=1 时也会返回），界面按「无账号」渲染一行。
 */
export function accountsOf(row) {
  if (!row) return []
  const count = Number(row.account_count) || 0
  const accountName = String(row.account_name || '').trim()
  if (!count && !accountName) return []
  return [
    {
      id: row.account_id ?? row.id ?? row.program_id,
      accountId: accountName || accountNameOf(row.user_credentials || row.credentials, ''),
      status: Number(row.enabled) === 1 ? 1 : 0,
      tokenStatus: tokenStatusOf(row.credential_status),
      priority: 0,
      lastSync: row.credential_checked_at || null,
      error: row.credential_error || ''
    }
  ]
}
