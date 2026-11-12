/**
 * 按「抓包字段清单」从一条抓包记录里捞值。
 *
 * CinemaGroup.captureConfig 里写的是手机上要填的字段名（mobile / tid / larkSid / _m_h5_tk…），
 * 这些值落点每家都不一样：有的在 cookie、有的在请求头、有的在 JSON 请求体、有的只在响应体里回显。
 * 所以不按固定路径取值，而是把整条记录翻一遍、按字段名对齐 —— 字段名本身就是契约。
 */

const MAX_BODY_CHARS = 512 * 1024
const MAX_DEPTH = 6

/** 一条记录里能对上多少个字段，就返回多少个 */
export function pickValues(record, keys) {
  /**
   * 字段名对齐不看大小写和分隔符：后台 schema 写的是 appletToken，
   * 请求头里是 `applet-token`，JSON 里可能是 `applet_token`，三种写法得算同一个字段。
   */
  const wanted = new Map()
  ;(keys || []).filter(Boolean).forEach((key) => wanted.set(normKey(key), String(key)))
  const out = {}
  if (!record || !wanted.size) return out

  const put = (key, value) => {
    const origin = wanted.get(normKey(key))
    if (!origin || value === undefined || value === null) return
    const text = typeof value === 'object' ? safeStringify(value) : String(value).trim()
    if (!text) return
    // 记录按时间从旧到新遍历，后写的覆盖先写的，留下的就是最近一次看到的值
    out[origin] = text
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
  const cookie = headerOf(record.reqHeaders, 'cookie')
  if (cookie) {
    cookie.split(';').forEach((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return
      put(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    })
  }

  // 3. 请求头 / 响应头本身可能就是字段（larkSid 这类自定义头）
  eachHeader(record.reqHeaders, put)
  eachHeader(record.resHeaders, put)

  // 4. JSON 体：请求体（登录提交的账号）优先，响应体兜底
  walkJson(parseJsonSafe(record.reqBody), put, 0)
  walkJson(parseJsonSafe(record.resBody), put, 0)

  return out
}

/** 字段名归一：appletToken / applet-token / APPET_TOKEN 都折成 applettoken */
function normKey(key) {
  return String(key || '')
    .toLowerCase()
    .replace(/[\s_-]/g, '')
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

function parseJsonSafe(text) {
  if (!text || typeof text !== 'string') return null
  if (text.length > MAX_BODY_CHARS) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
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

export default { pickValues }
