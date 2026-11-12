/**
 * 按「抓包字段清单」从一条抓包记录里捞值。
 *
 * CinemaGroup.captureConfig 里写的是手机上要填的字段名（mobile / tid / larkSid / _m_h5_tk…），
 * 这些值落点每家都不一样：有的在 cookie、有的在请求头、有的在 JSON 请求体、有的只在响应体里回显。
 * 所以不按固定路径取值，而是把整条记录翻一遍、按字段名对齐 —— 字段名本身就是契约。
 */

const MAX_BODY_CHARS = 512 * 1024
const MAX_DEPTH = 6

/**
 * 「手机号」这一栏的别名。
 *
 * 各家的登录接口几乎都不叫 phone：凤凰云智是 loginId，别的系统还有 loginName / account。
 * 这些名字本身太泛（account 完全可能是商户号），所以别名命中后还要求**值长得像手机号**
 * 才采用 —— 宁可空着让用户重抓，也不能往登录凭证里塞一个错值。
 */
const PHONE_ORIGIN_KEYS = new Set(['phone', 'mobile', 'tel', 'phonenumber', 'mobileno', '手机号'])
const PHONE_ALIAS_KEYS = new Set([
  'loginid',
  'loginname',
  'loginaccount',
  'account',
  'username',
  'useraccount',
  'mobilenumber',
  'mobilephone',
  'telphone',
  'phonecode'
])
const PHONE_VALUE_RE = /^\+?\d[\d-]{5,18}$/

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

  // 这次要抓的字段里，哪个是「手机号」那一栏（没有就是 null）
  const phoneOrigin =
    [...wanted.values()].find((key) => PHONE_ORIGIN_KEYS.has(normKey(key))) || null

  const put = (key, value) => {
    if (value === undefined || value === null) return
    const text = typeof value === 'object' ? safeStringify(value) : String(value).trim()
    if (!text) return

    const direct = wanted.get(normKey(key))
    if (direct) {
      // 记录按时间从旧到新遍历，后写的覆盖先写的，留下的就是最近一次看到的值
      out[direct] = text
      return
    }

    // 别名兜底：仅手机号栏，且值必须像手机号
    if (phoneOrigin && !out[phoneOrigin]) {
      if (PHONE_ALIAS_KEYS.has(normKey(key)) && PHONE_VALUE_RE.test(text)) {
        out[phoneOrigin] = text
      }
    }
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

  /**
   * 2.5 Set-Cookie：服务端**下发**的那一份。
   *
   * 这一路原来完全没读，而 H5 登录的 sid / tid 恰恰是登录成功响应里 Set-Cookie 下来的：
   * 用户登录完立刻点「获取参数」时，浏览器还没带着新 cookie 发下一个请求，
   * 只认「请求 cookie」就永远是空的。
   */
  eachSetCookie(record.resHeaders, put)

  // 3. 请求头 / 响应头本身可能就是字段（larkSid 这类自定义头）
  eachHeader(record.reqHeaders, put)
  eachHeader(record.resHeaders, put)

  /**
   * 4. 请求体 / 响应体。
   * 先按 JSON 走；不是 JSON 就按 form-urlencoded 解 —— 安卓/H5 登录表单是
   * `loginId=138xxx&password=...` 这种，原来是整段丢掉，手机号自然抓不到。
   */
  const reqJson = parseJsonSafe(record.reqBody)
  if (reqJson) walkJson(reqJson, put, 0)
  else parseFormSafe(record.reqBody, put)

  const resJson = parseJsonSafe(record.resBody)
  if (resJson) walkJson(resJson, put, 0)
  else parseFormSafe(record.resBody, put)

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
    // mtop / 部分 H5 会把参数再套一层，字面量是 JSON 字符串（data='{"loginId":"..."}'）
    if (typeof value === 'string' && value.length < 200000) {
      const trimmed = value.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const inner = parseJsonSafe(trimmed)
        if (inner) walkJson(inner, put, depth + 1)
      }
    }
  })
}

/** Set-Cookie 可能有多个（Node 里是数组），每个只取 `name=value` 那一段 */
function eachSetCookie(headers, put) {
  if (!headers) return
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'set-cookie')
  if (!key) return
  const raw = headers[key]
  const list = Array.isArray(raw) ? raw : splitSetCookie(String(raw || ''))
  list.forEach((entry) => {
    const first = String(entry).split(';')[0]
    const eq = first.indexOf('=')
    if (eq <= 0) return
    put(first.slice(0, eq).trim(), first.slice(eq + 1).trim())
  })
}

/**
 * 把一整串 Set-Cookie 拆成多条。
 * 不能在所有逗号上切：`Expires=Wed, 21 Oct 2026 07:28:00 GMT` 本身就带逗号，
 * 只有「逗号后面紧跟 name=」才是新的一条。
 */
function splitSetCookie(raw) {
  return raw.split(/,(?=\s*[^;,=\s]+=)/)
}

/**
 * form-urlencoded：a=1&b=2，解码后按字段名对齐。
 *
 * 这里必须再往下一层：mtop 系的登录请求是
 * `data=%7B%22loginId%22%3A%22138...%22%2C%22password%22%3A...%7D` ——
 * 表单值本身就是一个 JSON 字符串。只按表单键对齐的话，手机号 / larkSid
 * 全部藏在 `data` 这个值里面，一个都取不到（凤凰云智就是这么漏的）。
 */
function parseFormSafe(text, put) {
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body || body.length > MAX_BODY_CHARS) return
  if (!/^[^\s=&]+=[^&]*(&|$)/.test(body)) return
  body.split('&').forEach((pair) => {
    if (!pair) return
    const eq = pair.indexOf('=')
    if (eq <= 0) return
    const name = decodeSafe(pair.slice(0, eq))
    const value = decodeSafe(pair.slice(eq + 1))
    put(name, value)
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const inner = parseJsonSafe(trimmed)
      if (inner) walkJson(inner, put, 0)
    }
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

/**
 * 没抓到时给人看的线索：这段时间到底经过哪些域名、出现过哪些 cookie / 头 / 字段名。
 *
 * 参数名是后台 schema 写死的，流量里的名字经常是另一个写法（phone vs loginId、
 * larkSid vs lark_sid）。光说「没抓到」没法判断是没流量还是名字对不上，
 * 把见到的名字抖出来，一次就能定位。
 */
export function describeTraffic(records) {
  const hosts = new Set()
  const names = new Set()

  const pushName = (name) => {
    const text = String(name || '').trim()
    if (text && text.length <= 40) names.add(text)
  }
  const pushPairs = (text, sep) => {
    String(text || '')
      .split(sep)
      .forEach((pair) => {
        const eq = pair.indexOf('=')
        if (eq > 0) pushName(pair.slice(0, eq).trim())
      })
  }

  ;(records || []).forEach((record) => {
    if (!record) return
    if (record.host) hosts.add(record.host)

    pushPairs(headerOf(record.reqHeaders, 'cookie'), ';')

    const setCookie = headerOf(record.resHeaders, 'set-cookie')
    if (setCookie) {
      splitSetCookie(setCookie).forEach((entry) => pushPairs(entry, ';'))
    }

    Object.keys(record.reqHeaders || {}).forEach(pushName)
    Object.keys(record.resHeaders || {}).forEach(pushName)

    const reqJson = parseJsonSafe(record.reqBody)
    if (reqJson) collectKeys(reqJson, pushName, 0)
    else pushPairs(record.reqBody, '&')

    const resJson = parseJsonSafe(record.resBody)
    if (resJson) collectKeys(resJson, pushName, 0)
  })

  return { hosts: [...hosts].slice(0, 10), names: [...names].slice(0, 40) }
}

function collectKeys(node, push, depth) {
  if (!node || typeof node !== 'object' || depth > 3) return
  if (Array.isArray(node)) {
    node.slice(0, 5).forEach((item) => collectKeys(item, push, depth + 1))
    return
  }
  Object.keys(node).forEach((key) => {
    push(key)
    const value = node[key]
    if (value && typeof value === 'object') collectKeys(value, push, depth + 1)
  })
}

export default { pickValues, describeTraffic }
