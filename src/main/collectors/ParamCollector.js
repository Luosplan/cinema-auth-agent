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
 * 各家的登录接口几乎都不叫 phone：凤凰云智 H5 登录请求里叫 `principal`
 * （`data={"type":"MOBILE","principal":"17762682464"}`），
 * 而登录响应 / getaccountid 响应里又老老实实叫 `mobile`。
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
  'phonecode',
  // 凤凰云智：登录请求里的手机号字段
  'principal'
])

/**
 * 「同义手机号字段」——和 PHONE_ORIGIN_KEYS 是**互为别名**的。
 *
 * 后台字段清单里这一栏写过 phone，也写过 mobile；而流量里叫什么完全由系统决定。
 * 凤凰云智 H5 就是这么漏的：后台配的是 `phone`，getaccountid 响应里叫 `mobile`，
 * 直接命中查不到，别名表里又没有 mobile，于是四个 cookie/请求体字段都有、唯独手机号永远空。
 * 所以两边互相认：要抓 phone 就接受 mobile，要抓 mobile 也接受 phone。
 */
const PHONE_ECHO_KEYS = new Set([
  ...PHONE_ORIGIN_KEYS,
  'temporarymobile',
  'mobilenumber',
  'mobilephone',
  'telphone'
])

/** 明确是「手机号字段」时用的宽松判定：6~19 位数字，允许 +、- 分隔 */
const PHONE_VALUE_RE = /^\+?\d[\d-]{5,18}$/

/**
 * 非手机号字段的别名：后台配的名字 ← 流量里可能出现的其它叫法。
 *
 * 只收「语义上确定是同一个东西」的，宁可漏一条也不要误收：
 * 别名一旦配错，取值不会报错，只会悄悄塞进一个错误的凭证。
 *
 *   larkSid ← sid
 *     凤凰云智的 auth.getsidbytid：请求体带的是**旧** sid（字段名就叫 larkSid），
 *     响应体 `bizValue.sid` 是换来**新** sid —— 服务端适配器也是拿它当新 larkSid 用的。
 *     不认这个别名，抓到的永远是浏览器手里那个即将被换掉的旧值。
 *
 *   token ← x-access-token / accessToken
 *     随映（shallyim）的 token 只放在 HTTP 头 `X-Access-Token` 里，不是 JSON 字段。
 *     后台那一栏配的是 `token`，直接比名字永远对不上，表现就是「值明明有、这一栏永远空」。
 *     小程序系的 accessToken 同理（不少系统后台写 token、流量里叫 accessToken）。
 *
 *   openId ← wxOpenid
 *     微信小程序授权接口回的是 `wxOpenid`，后台那一栏配的是 `openId`。
 *     归一化后是 openid vs wxopenid，差的正是那个 wx 前缀，不认就永远是空。
 *
 * 只在后台确实要 `larkSid` 这一栏时才生效，不影响其它系统的同名字段。
 */
const KEY_ALIASES = {
  larksid: ['sid'],
  token: ['xaccesstoken', 'accesstoken'],
  // openId 与 wxOpenid 互为别名：后台写哪个都得认，流量里也可能是另一个
  openid: ['wxopenid'],
  wxopenid: ['openid']
}

/**
 * 泛字段（account / username / principal…）用的严格判定。
 *
 * 这些名字完全可能是商户号、账号 ID（凤凰云智的 accountId 是 16 位纯数字，
 * 宽松正则照样匹配）。宁可只认「像手机号的」：大陆 11 位、香港/澳门 8 位。
 * 认不出就让手机号空着，也不要往登录凭证里塞一个商户号。
 */
const PHONE_STRICT_RE = /^(?:\+?86)?1[3-9]\d{9}$|^\+?(?:852|853)?[4-9]\d{7}$/

/** 这个字段名是不是「手机号」那一栏（后台写 mobile / phone / 手机号） */
export function isPhoneKey(key) {
  return PHONE_ORIGIN_KEYS.has(normKey(key))
}

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

  /**
   * 手机号取值的来源等级（数字越大越该留下）。
   *
   * 为什么要分等级：一条记录是「请求 → 响应」按顺序翻的，而手机号在两个地方都出现 ——
   * 登录请求体里的 `principal`（**这次登录用的手机号**）和登录/取账号响应里回显的
   * `mobile`（**账号在系统里登记的手机号**）。两者不一定是同一个号，
   * 按原来「后写覆盖」的规则，响应里的登记手机号永远会盖掉请求里的登录手机号，
   * 表现就是「我浏览器抓包登录的根本不是这个账号，表格里却显示另一个号」。
   * 所以登录账号字段给更高等级：它一旦拿到，后面回显的同义字段不能覆盖它。
   */
  const PHONE_RANK = { echo: 1, login: 2 }
  const phoneRank = new Map()

  /** 把流量里的叫法映射成后台配置的字段名；只有后台确实要这个字段时才生效 */
  const aliasOf = (name) => {
    for (const target of Object.keys(KEY_ALIASES)) {
      if (!wanted.has(target)) continue
      if (KEY_ALIASES[target].includes(name)) return wanted.get(target)
    }
    return undefined
  }

  const put = (key, value) => {
    if (value === undefined || value === null) return
    const text = typeof value === 'object' ? safeStringify(value) : String(value).trim()
    if (!text) return

    const fieldName = normKey(key)
    const direct = wanted.get(fieldName) || aliasOf(fieldName)
    if (direct) {
      if (phoneOrigin && direct === phoneOrigin) {
        // 直接命中（mobile / phone…）算「回显」：低等级，不能盖掉登录账号字段
        if ((phoneRank.get(direct) || 0) > PHONE_RANK.echo) return
        out[direct] = text
        phoneRank.set(direct, PHONE_RANK.echo)
        return
      }
      // 记录按时间从旧到新遍历，后写的覆盖先写的，留下的就是最近一次看到的值
      out[direct] = text
      return
    }

    /**
     * 别名兜底：仅手机号栏，且值必须像手机号。
     *
     * 分两档：
     *   - 同义字段（mobile ↔ phone ↔ 手机号…）算「回显」，等级 1；
     *   - 登录账号字段（principal / loginId…）算「这次登录用的号」，等级 2，可以压过回显。
     * 等级低的不能盖等级高的，同等级后写覆盖（取最近一次）。
     */
    if (phoneOrigin) {
      const name = normKey(key)
      const isEcho = PHONE_ECHO_KEYS.has(name)
      const isLogin = PHONE_ALIAS_KEYS.has(name)
      // 泛字段用严格判定，明确手机号字段用宽松判定（见两个正则的注释）
      const pattern = isLogin ? PHONE_STRICT_RE : PHONE_VALUE_RE
      if ((isEcho || isLogin) && pattern.test(text)) {
        const rank = isLogin ? PHONE_RANK.login : PHONE_RANK.echo
        if ((phoneRank.get(phoneOrigin) || 0) > rank) return
        out[phoneOrigin] = text
        phoneRank.set(phoneOrigin, rank)
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
   * 3.5 `Location` 头里的查询参数。
   *
   * 微信授权登录经常是 302：响应体是空的，凭证（code / openid）全在跳转地址的 query 里。
   * 只读 body 的话这条记录什么都拿不到，而它恰恰是唯一带 openid 的那条。
   */
  const location = headerOf(record.resHeaders, 'location')
  if (location) {
    const q = location.indexOf('?')
    if (q >= 0) {
      location
        .slice(q + 1)
        .split('#')[0]
        .split('&')
        .forEach((pair) => {
          const eq = pair.indexOf('=')
          if (eq <= 0) return
          put(decodeSafe(pair.slice(0, eq)), decodeSafe(pair.slice(eq + 1)))
        })
    }
  }

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

  /**
   * 5. JWT 载荷。
   *
   * 小程序的 token 基本都是 JWT，而 openId / userId / tenantId 这类标识**就写在载荷里**。
   * 随映（shallyim）是最典型的例子：响应体的 `wxOpenid` 和 `X-Access-Token` 载荷里的
   * `openId` 是同一个值。所以只要拿到了 token，openId 就一定拿得到 ——
   * 不依赖响应体有没有解开、也不受嵌套深度限制，比解析响应体可靠得多。
   */
  const jwts = []
  const noteJwt = (value) => {
    const text = String(value || '')
      .replace(/^Bearer\s+/i, '')
      .trim()
    if (text && JWT_RE.test(text) && jwts.length < 6) jwts.push(text)
  }
  ;[record.reqHeaders, record.resHeaders].forEach((headers) => {
    if (!headers) return
    Object.values(headers).forEach(noteJwt)
  })
  // 已经取到的 token 也解一次（有的系统 token 只出现在请求体里）
  Object.values(out).forEach(noteJwt)
  jwts.forEach((jwt) => {
    const payload = decodeJwtPayload(jwt)
    if (payload) walkJson(payload, put, 0)
  })

  /**
   * 6. 兜底：还有字段没拿到时，直接在原始报文里按 `"名字":"值"` 再捞一遍。
   *
   * 为什么需要：上面的结构化遍历有两个硬限制 ——
   *   - `MAX_DEPTH = 6`，而真实登录响应常是 `data.bizValue.member.wxUser.wxOpenid`
   *     这种更深一层的嵌套，遍历到第 7 层就 return 了，字段明明在却拿不到；
   *   - 有些接口把整个 JSON 当字符串塞进某个字段（再嵌一层），或用的是非标准 JSON。
   *
   * 按名字捞不受嵌套深度影响，代价是可能匹配到同名的非目标字段 ——
   * 对凭证类字段来说，捞到比漏掉强。匹配到的仍然走 put()，手机号的严格判定、
   * 字段别名（wxOpenid → openId）、取值等级都照旧生效。
   */
  const stillMissing = [...wanted.keys()].some((name) => out[wanted.get(name)] === undefined)
  if (stillMissing) {
    /**
     * 每条只扫前 64KB：面板 800ms 轮询一次、一次 60 条记录，
     * 不封顶的话大响应会把这个兜底变成性能问题；凭证字段基本都在报文靠前的位置。
     */
    const rawText = `${decodeSafe(record.reqBody)} ${record.resBody || ''}`.slice(0, 64 * 1024)
    if (rawText) {
      for (const match of rawText.matchAll(JSON_PAIR_RE)) {
        let value = match[2]
        // 值里有转义（\" \\ \/ 之类）时还原成真实字符串，否则会把反斜杠写进凭证
        if (value.includes('\\')) {
          try {
            value = JSON.parse(`"${value}"`)
          } catch {
            /* 解不开就用原样 */
          }
        }
        put(match[1], value)
      }
    }
  }

  return out
}

/**
 * 报文里的 `"key":"value"` 对。
 * 值里允许转义字符（\" \\ 之类），但长度封顶，避免在超长单行上报文上回溯爆掉。
 */
const JSON_PAIR_RE = /"([A-Za-z0-9_\-.]{1,64})"\s*:\s*"((?:[^"\\]|\\.){1,4096})"/g

/** JWT 的形状：三段 base64url，用点分隔（签名段可能为空，所以第三段允许空） */
const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{0,}$/

/**
 * 解出 JWT 的载荷（payload 段）。
 *
 * 只解不验签：这里只关心载荷里写了什么（openId / userId 这些标识），
 * 凭证是否有效由服务端验，工具不需要也不该去碰签名。
 */
function decodeJwtPayload(token) {
  const parts = String(token || '').split('.')
  if (parts.length < 2 || !parts[1]) return null
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
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
/**
 * 这些字段名在抓到的流量里**到底有没有出现过**。
 *
 * 用来区分两件完全不同的事，也是抓不到时最容易误判的地方：
 *   - 出现过但没取到 → 解析/别名的问题，改代码
 *   - 从头到尾没出现过 → 流量里根本没有这个字段，再刷新页面也抓不到，
 *     多半是这套接口不认它（比如随映的 openId：适配器发请求时根本不用），该改配置
 *
 * 比较前把两边都去掉分隔符并转小写：后台写 `member_id`、请求头写 `memberId`、
 * 代码里写 `x-access-token` / `X-Access-Token` —— 都得算同一个名字。
 */
export function fieldsNeverSeen(records, keys) {
  const list = Array.isArray(records) ? records : []
  const wanted = (keys || []).filter(Boolean).map(String)
  if (!list.length || !wanted.length) return []

  /** 每条只取前 4000 字：字段名基本都出现在头部或报文开头，没必要把整包都拼进来 */
  const hay = list
    .slice(-40)
    .map((record) => {
      const head = `${JSON.stringify(record.reqHeaders || {})} ${JSON.stringify(record.resHeaders || {})}`
      const body = `${decodeSafe(record.reqBody)} ${record.resBody || ''}`
      return `${head} ${body}`.slice(0, 4000)
    })
    .join(' ')
    .toLowerCase()
    .replace(/[\s_\-:"]/g, '')

  return wanted.filter((key) => {
    const name = String(key)
      .trim()
      .toLowerCase()
      .replace(/[\s_-]/g, '')
    if (!name) return false
    return !hay.includes(name)
  })
}

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
