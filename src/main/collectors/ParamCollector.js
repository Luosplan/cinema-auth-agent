/**
 * 按「抓包字段清单」从一条抓包记录里捞值。
 *
 * CinemaGroup.captureConfig 里写的是手机上要填的字段名（mobile / tid / larkSid / _m_h5_tk…），
 * 这些值落点每家都不一样：有的在 cookie、有的在请求头、有的在 JSON 请求体、有的只在响应体里回显。
 * 所以不按固定路径取值，而是把整条记录翻一遍、按字段名对齐 —— 字段名本身就是契约。
 *
 * 名字对齐要宽容一点：接口里的大小写常常和后台写的不同（larkSid / larksid），
 * 还有些字段在系统内部根本换了名字（后台要 larkSid，前端源码里叫 sid），
 * 所以匹配走「小写 + 别名表」，而不是严格相等 —— 严格相等会让这类字段永远抓不到。
 */

import { FIELD_ALIASES, normalizeKey } from './ParamResolver.js'
import { parseBody } from './body.js'

const MAX_DEPTH = 6

/** 目标字段 → 实际可能出现的名字（全部小写），命中任一即算这个字段 */
function buildMatcher(keys) {
  const map = new Map()
  for (const key of keys) {
    const lower = String(key).toLowerCase()
    map.set(lower, key)
    const aliases = FIELD_ALIASES[normalizeKey(key)]
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        const a = String(alias).toLowerCase()
        // 先到先得：多个字段共用同一个别名时，别让后加的字段把前面的挤掉
        if (!map.has(a)) map.set(a, key)
      }
    }
  }
  return map
}

/**
 * 值合理性校验：同一个名字在不同上下文里含义完全不同。
 *
 * 最典型的是手机号 —— 页面存储里埋点对象（APLUS_* 这类）也有个 `mobile` 字段，
 * 值是 0。通用按名匹配会把 0 当成手机号，还把真正的 17762682464 覆盖掉。
 * 抓到假值比抓不到更糟，所以同名但明显不像的，直接不要。
 */
const PLAUSIBLE = {
  mobile: (v) => /^\+?\d{7,15}$/.test(String(v).replace(/[\s-]/g, '')),
  phone: (v) => /^\+?\d{7,15}$/.test(String(v).replace(/[\s-]/g, '')),
  larksid: (v) => String(v).length >= 8 && !/^\d{1,3}$/.test(String(v)),
  tid: (v) => String(v).length >= 8,
  // 太短的一定不是凭证：接口里常把 token 字段置空或写成占位符（"-"、"0"、"null"）
  token: (v) => String(v).length >= 8,
  authorization: (v) => String(v).length >= 8,
  refreshtoken: (v) => String(v).length >= 8
}

function plausible(key, text) {
  const rule = PLAUSIBLE[normalizeKey(key)]
  if (!rule) return true
  return rule(text)
}

/** 鉴权类的值可能带 `Bearer ` 前缀，上报给服务端必须剥掉，否则是一段废值 */
const AUTH_KEYS = new Set(['token', 'authorization', 'refreshtoken'])

/** 一条记录里能对上多少个字段，就返回多少个 */
export function pickValues(record, keys) {
  const out = {}
  const wanted = (keys || []).filter(Boolean).map(String)
  if (!record || !wanted.length) return out
  const matcher = buildMatcher(wanted)

  const put = (name, value) => {
    if (value === undefined || value === null) return
    const target = matcher.get(String(name).toLowerCase())
    if (!target) return
    let text = typeof value === 'object' ? safeStringify(value) : String(value).trim()
    if (AUTH_KEYS.has(normalizeKey(target))) text = text.replace(/^bearer\s+/i, '').trim()
    if (!text) return
    if (!plausible(target, text)) return
    // 记录按时间从旧到新遍历，后写的覆盖先写的，留下的就是最近一次看到的值
    out[target] = text
  }

  // 1. URL 查询串
  const url = String(record.path || '')
  const qsIndex = url.indexOf('?')
  if (qsIndex >= 0) {
    url
      .slice(qsIndex + 1)
      .split('&')
      .forEach((pair) => {
        if (!pair) return
        const eq = pair.indexOf('=')
        if (eq < 0) return
        put(decodeSafe(pair.slice(0, eq)), decodeSafe(pair.slice(eq + 1)))
      })
  }

  // 2. cookie：H5 系的 tid / _m_h5_tk 基本都在这里
  //    响应侧的 set-cookie 也要读 —— 一部分系统的会话 cookie 只在登录响应的
  //    set-cookie 里下发一次，之后请求头里才带上，错过那一次就再也等不到
  const cookie = headerOf(record.reqHeaders, 'cookie')
  if (cookie) putCookiePairs(cookie, put)
  for (const raw of toArray(headerOf(record.resHeaders, 'set-cookie'))) {
    // set-cookie 每条只取第一段 `name=value; Path=/; HttpOnly`
    putCookiePairs(String(raw).split(';')[0], put)
  }

  // 3. 请求头 / 响应头本身可能就是字段（larkSid 这类自定义头）
  eachHeader(record.reqHeaders, put)
  eachHeader(record.resHeaders, put)

  // 4. 请求体（登录提交的账号）优先，响应体兜底。
  //    body 可能是 JSON，也可能是 x-www-form-urlencoded —— mini 系的登录接口就是表单，
  //    只认 JSON 的话 token/agent 永远抓不到，只能抓到 JSON 响应里的 openid
  walkJson(parseBody(record.reqBody), put, 0)
  walkJson(parseBody(record.resBody), put, 0)

  return out
}

/** `a=1; b=2` 切成 k/v 逐个 put；值里的 `=` 不截断 */
function putCookiePairs(text, put) {
  String(text || '')
    .split(';')
    .forEach((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return
      put(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    })
}

function toArray(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function eachHeader(headers, put) {
  if (!headers) return
  Object.keys(headers).forEach((name) => {
    const value = headers[name]
    if (value === undefined || value === null) return
    put(name, value)
    // header 名不区分大小写，两种写法都喂进去，让 wanted 去判
    put(name.toLowerCase(), value)
  })
}

function headerOf(headers, name) {
  if (!headers) return ''
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key ? String(headers[key] || '') : ''
}

function walkJson(node, put, depth) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return
  if (Array.isArray(node)) {
    node.forEach((item) => walkJson(item, put, depth + 1))
    return
  }
  Object.keys(node).forEach((key) => {
    const value = node[key]
    if (value && typeof value === 'object') {
      // 对象本身也可能是要的值，交给 put 判一下；再往下递归
      put(key, value)
      walkJson(value, put, depth + 1)
      return
    }
    put(key, value)
  })
}

/**
 * 一条记录里出现过的所有字段名（只返回名字，绝不返回值）。
 *
 * 用途只有一个：某个字段明明在页面上有、我们却抓不到时，用来反查接口到底把它叫什么。
 * 没有这个，「token 抓不到」只能靠猜 —— 而猜错的代价是往后台填一个假的 token。
 *
 * @returns {Set<string>}
 */
export function listFieldNames(record) {
  const names = new Set()
  const note = (name) => {
    const text = String(name || '').trim()
    if (text) names.add(text)
  }

  if (!record) return names

  // 查询串
  const url = String(record.path || '')
  const qsIndex = url.indexOf('?')
  if (qsIndex >= 0) {
    url
      .slice(qsIndex + 1)
      .split('&')
      .forEach((pair) => {
        const eq = pair.indexOf('=')
        if (eq > 0) note(decodeSafe(pair.slice(0, eq)))
      })
  }

  // cookie 名（请求 cookie + 响应 set-cookie）
  const cookie = headerOf(record.reqHeaders, 'cookie')
  if (cookie) {
    cookie.split(';').forEach((pair) => {
      const eq = pair.indexOf('=')
      if (eq > 0) note(pair.slice(0, eq))
    })
  }
  for (const raw of toArray(headerOf(record.resHeaders, 'set-cookie'))) {
    const first = String(raw).split(';')[0]
    const eq = first.indexOf('=')
    if (eq > 0) note(first.slice(0, eq))
  }

  // 头名本身
  for (const source of [record.reqHeaders, record.resHeaders]) {
    for (const key of Object.keys(source || {})) note(key)
  }

  // body 里的键名：JSON 和表单都认，只到第二层足够定位
  walkNames(parseBody(record.reqBody), note, 0)
  walkNames(parseBody(record.resBody), note, 0)

  return names
}

function walkNames(node, note, depth) {
  if (!node || typeof node !== 'object' || depth > 2) return
  if (Array.isArray(node)) {
    node.forEach((item) => walkNames(item, note, depth + 1))
    return
  }
  Object.keys(node).forEach((key) => {
    note(key)
    const value = node[key]
    if (value && typeof value === 'object') walkNames(value, note, depth + 1)
  })
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

export default { pickValues, listFieldNames }
