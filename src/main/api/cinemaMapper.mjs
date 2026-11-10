/**
 * 出票系统（ticket-server）响应 → 界面数据结构的适配层。
 *
 * 这里只做纯数据转换，不碰 electron / 网络，方便单独跑脚本验证。
 * 服务端形状见 `GET /api/cinemas`：
 *   [{ id, name, city, system, standard_id, credentials, enabled,
 *      credential_status, credential_checked_at, credential_error }]
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

/** 服务端扁平的影城行 → 界面要的 { id, name, children[] } 两级树 */
export function buildCinemaTree(rows) {
  const list = Array.isArray(rows) ? rows : []
  const groups = new Map()
  for (const row of list) {
    const systemCode = String(row.system || '').trim()
    const groupId = systemCode || 'unknown'
    if (!groups.has(groupId)) {
      groups.set(groupId, { id: groupId, name: systemLabel(systemCode), children: [] })
    }
    groups.get(groupId).children.push({
      id: row.id,
      name: row.name || '',
      code: row.standard_id || '',
      city: row.city || '',
      systemCode,
      // 接入方式服务端没给，界面会显示成「—」
      accessType: row.access_type || row.accessType || '',
      captureConfig: captureConfigOf(row.credentials),
      enabled: Number(row.enabled) === 1
    })
  }
  return [...groups.values()]
}

/**
 * 凭证挂在影城上（一个影城一套 credentials），界面按「一影城一行账号」渲染。
 * 注意：credentials 里主要是影城级参数（cinema_id / baseUrl / channel_code），
 * 账号级字段（mobile / token）只有叠加了 user_cinema_credentials 才出现，
 * 所以取不到手机号时会退回影城名。
 */
export function accountsOf(row) {
  if (!row) return []
  return [
    {
      id: row.id,
      accountId: accountNameOf(row.credentials, row.name),
      status: Number(row.enabled) === 1 ? 1 : 0,
      tokenStatus: tokenStatusOf(row.credential_status),
      priority: 0,
      lastSync: row.credential_checked_at || null,
      error: row.credential_error || ''
    }
  ]
}
