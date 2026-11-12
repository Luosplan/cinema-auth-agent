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

/** 出票系统内部代号 → 界面显示名；没收录的直接显示代号，不至于空白 */
export const SYSTEM_LABELS = {
  hkticketing: 'HK 票务',
  phoenix: '凤凰',
  'phoenix-mini': '凤凰小程序',
  jingyu: '鲸鱼',
  huiyingpiao: '慧影票',
  guoyu: '国宇',
  oristar: '奥映',
  pandora: '潘多拉',
  yingyuan360: '影院360',
  laiyipiao: '来一票',
  imovie365: 'IMovie365',
  sgycyk: '省广影城',
  'cx-v1': '晨星 V1',
  'cx-v3': '晨星 V3',
  'cx-v104': '晨星 V104',
  'cx-middleground': '晨星中台',
  'mini-v1': '小程序 V1',
  'mini-v2': '小程序 V2'
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

export function systemLabel(code) {
  const key = String(code || '').trim()
  if (!key) return '未指定系统'
  return SYSTEM_LABELS[key] || SYSTEM_LABELS[key.toLowerCase()] || key
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
  list.forEach((row, index) => {
    const systemCode = String(row.system || row.program_key || row.runtime_system || '').trim()
    const groupId = systemCode || 'unknown'
    if (!groups.has(groupId)) {
      groups.set(groupId, { id: groupId, name: systemLabel(systemCode), children: [] })
    }
    const programId = Number(row.program_id ?? 0)
    groups.get(groupId).children.push({
      // program_id 一定在；账号配置 id 只有配过账号才有，不能当主键
      id: programId || Number(row.id ?? row.account_id ?? 0) || index + 1,
      programId,
      name: row.name || row.program_name || '',
      code: String(row.cinema_standard_ids || '').split(',')[0] || '',
      city: row.city || row.cinema_cities || '',
      systemCode,
      accessType: accessTypeOf(row),
      captureConfig: captureConfigOf(row.user_credentials || row.credentials),
      enabled: Number(row.enabled) === 1,
      accountId: row.account_name || '',
      accountCount: Number(row.account_count) || 0,
      // 账号直接随行带下去，界面不用为每个程序再走一次 IPC
      accounts: accountsOf(row),
      credentialStatus: row.credential_status || '',
      cinemaCount: Number(row.cinema_count) || 1,
      cinemaNames: Array.isArray(row.cinema_id_names)
        ? row.cinema_id_names.map((c) => c.name).filter(Boolean)
        : []
    })
  })
  return [...groups.values()]
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
