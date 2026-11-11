/**
 * 参数解析的「精确层」。
 *
 * 后台 CinemaGroup.captureConfig 给的是字段名清单（mobile / k / openid / Authorization），
 * 通用的按名匹配（ParamCollector.pickValues）能覆盖大部分情况，
 * 但有两类它一定猜不对，必须由规则显式指定：
 *
 *   1. 名字对不上：后台要 openid，实际字段叫 openId；要 手机号，实际叫 mobilePhone。
 *   2. 有明显坑位：奥斯卡的公共请求体里就有一个 k="123" 的占位值，
 *      真正的 k 在另一个接口响应的 data.baseTypeRes 里，
 *      按名匹配会稳定抓到 "123" —— 抓到假值比抓不到更糟。
 *
 * 所以这里不追求「什么都能猜」，只负责：显式路径 > 别名 > 放弃，
 * 猜不到就把字段留给通用匹配或留给操作员手动补。
 */

/** 递归查找的最大深度：真实接口很少超过 5 层，再深基本是列表项，容易误抓 */
const MAX_DEPTH = 5

const EMPTY_VALUES = new Set(['', 'null', 'undefined', 'nan', 'none'])

/**
 * 字段名 → 可能出现的真实字段名（全部小写比较）。
 * 加一套新系统时，通常只需要往这里补一行别名。
 */
export const FIELD_ALIASES = {
  mobile: [
    'mobile',
    'mobilephone',
    'mobiletelephone',
    'phonenum',
    'phone',
    'tel',
    'membermobile',
    'loginmobile',
    'userphone'
  ],
  openid: ['openid', 'open_id', 'wxopenid', 'wx_openid', 'thirdopenid', 'useropenid'],
  unionid: ['unionid', 'union_id', 'wxunionid'],
  authorization: ['accesstoken', 'access_token', 'authtoken'],
  token: ['token', 'accesstoken', 'access_token', 'thirdsession', 'sessionid'],
  refreshtoken: ['refreshtoken', 'refresh_token'],
  k: ['k'],
  tenantid: ['tenantid', 'tenant_id'],
  nickname: ['nickname', 'nick_name', 'username', 'membername'],
  memberid: ['memberid', 'member_id', 'userid', 'user_id', 'vipid']
}

/** 鉴权类字段优先从请求头取，别在 JSON 里乱翻 */
const HEADER_FIRST = {
  authorization: ['authorization', 'x-access-token', 'x-token', 'accesstoken'],
  tenantid: ['tenant-id', 'tenantid']
}

/** 后台字段名可能是中文，统一收敛成规范 key */
const KEY_ALIASES = {
  手机号: 'mobile',
  手机: 'mobile',
  电话: 'mobile',
  昵称: 'nickname',
  会员id: 'memberid',
  会员成本: '',
  备注: ''
}

export function normalizeKey(key) {
  const raw = String(key || '').trim()
  const mapped = KEY_ALIASES[raw.toLowerCase()]
  if (mapped !== undefined) return mapped
  return raw.toLowerCase().replace(/[\s_\-:：]/g, '')
}

function isUsableValue(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'object') return false
  const text = String(value).trim()
  if (!text) return false
  return !EMPTY_VALUES.has(text.toLowerCase())
}

function pickByPath(obj, path) {
  if (!obj || !path) return undefined
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj)
}

/** 同层优先、再逐层深入，返回路径便于界面展示来源 */
function findInObject(obj, names, depth = 0, prefix = '') {
  if (!obj || typeof obj !== 'object' || depth > MAX_DEPTH) return null

  const byLower = new Map()
  for (const key of Object.keys(obj)) byLower.set(key.toLowerCase(), key)

  for (const name of names) {
    const real = byLower.get(String(name).toLowerCase())
    if (real === undefined) continue
    const value = obj[real]
    if (!isUsableValue(value)) continue
    return { value: String(value).trim(), path: prefix ? `${prefix}.${real}` : real }
  }

  for (const key of Object.keys(obj)) {
    const value = obj[key]
    if (!value || typeof value !== 'object') continue
    const hit = findInObject(value, names, depth + 1, prefix ? `${prefix}.${key}` : key)
    if (hit) return hit
  }

  return null
}

function pickHeader(headers, names) {
  if (!headers || !names?.length) return null
  for (const name of names) {
    const value = headers[String(name).toLowerCase()] ?? headers[name]
    if (isUsableValue(value)) return String(value).trim()
  }
  return null
}

function safeJson(text) {
  if (!text || typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/**
 * 规则里对该字段的显式声明（可选）。
 * 形如：{ k: { paths: ['data.baseTypeRes'], deny: ['123'] } }
 */
function ruleDefFor(rule, key) {
  const list = rule?.params || []
  for (const item of list) {
    if (typeof item === 'string') {
      if (normalizeKey(item) === key) return {}
      continue
    }
    if (item && normalizeKey(item.key || '') === key) return item
  }
  return null
}

/** 取规则里某个字段的显式声明，没声明返回空对象 */
export function paramDef(rule, rawKey) {
  return ruleDefFor(rule, normalizeKey(rawKey)) || {}
}

/** 常见字段的中文名，只用于界面展示；后台自己给 label 时以后台为准 */
const KEY_LABELS = {
  mobile: '手机号',
  authorization: 'Authorization',
  token: 'Token',
  refreshtoken: 'refreshToken',
  tenantid: '租户 ID',
  nickname: '昵称',
  memberid: '会员 ID'
}

/**
 * 把规则里的字段清单整理成界面/接口用的形状。
 * 兼容两种写法：`['mobile', 'k']` 和 `[{ key:'mobile', label:'手机号', required:true }]`。
 */
export function describeParams(rule) {
  const list = rule?.params
  if (!Array.isArray(list)) return []
  return list.map((item, i) => {
    if (typeof item === 'string') {
      const key = normalizeKey(item) || item
      return { key, label: KEY_LABELS[key] || item, required: true }
    }
    const key = String(item?.key || item?.label || `参数${i + 1}`)
    return {
      key,
      label: String(item?.label || KEY_LABELS[normalizeKey(key)] || key),
      required: item?.required !== false
    }
  })
}

/**
 * 解析一条抓包记录里的指定字段。
 *
 * @param {object} rule    命中 host 的规则（可含 params 显式声明）
 * @param {object} record  抓包记录
 * @param {string[]} keys  后台要的字段名（captureConfig 里的 key）
 * @returns {Object<string,{value:string, from:string}>}
 */
export function resolveForKeys(rule, record, keys) {
  if (!record || !Array.isArray(keys) || !keys.length) return {}

  const headers = record.reqHeaders || {}
  const reqJson = safeJson(record.reqBody)
  const resJson = safeJson(record.resBody)

  const out = {}

  for (const rawKey of keys) {
    const key = normalizeKey(rawKey)
    if (!key) continue

    const def = ruleDefFor(rule, key) || {}
    const aliasList = def.aliases || FIELD_ALIASES[key] || [rawKey]
    const deny = new Set((def.deny || []).map((v) => String(v).toLowerCase()))
    let hit = null

    const useIt = (value, from) => {
      if (!isUsableValue(value)) return false
      const text = String(value).trim()
      if (deny.has(text.toLowerCase())) return false
      hit = { value: text, from }
      return true
    }

    // 1) 显式请求头
    if (def.header) useIt(pickHeader(headers, [def.header]), `请求头 ${def.header}`)

    // 2) 鉴权类字段兜一圈常见头名
    if (!hit && HEADER_FIRST[key]) {
      const value = pickHeader(headers, HEADER_FIRST[key])
      if (value) useIt(value, '请求头')
    }

    // 3) 显式请求体路径（openid 这类只是入参）
    if (!hit && def.reqPaths?.length && reqJson) {
      for (const path of def.reqPaths) {
        if (useIt(pickByPath(reqJson, path), `请求体 ${path}`)) break
      }
    }

    // 4) 显式响应体路径（k 这种必须精确到字段，防止抓到公共参数里的占位值）
    if (!hit && def.paths?.length && resJson) {
      for (const path of def.paths) {
        if (useIt(pickByPath(resJson, path), `响应体 ${path}`)) break
      }
    }

    // 5) 别名：请求体优先（入参），再响应体（回显）
    if (!hit && reqJson) {
      const found = findInObject(reqJson, aliasList)
      if (found) useIt(found.value, `请求体 ${found.path}`)
    }
    if (!hit && resJson) {
      const found = findInObject(resJson, aliasList)
      if (found) useIt(found.value, `响应体 ${found.path}`)
    }

    if (hit) out[rawKey] = hit
  }

  return out
}

export default { resolveForKeys, describeParams, paramDef, normalizeKey, FIELD_ALIASES }
