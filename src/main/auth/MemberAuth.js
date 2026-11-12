import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { resolveApiBase } from '../config/endpoints.js'

/**
 * 后台账号登录（凭证采集端的「我是谁」）。
 *
 * 走 HK 票务后台的账号体系，不自建：
 *   - `POST /api/login` 收 `{ username, password }`，回
 *     `{ success, token, id, username, role, canViewLogs, canViewOrderPool, canViewReleases }`；
 *     响应是**扁平的**，不像业务接口那样包一层 data。
 *   - 后续接口都认 `Authorization: Bearer <token>`，JWT 有效期 7 天（exp 里写着，直接读），
 *     **没有 refresh 接口** —— 所以这里不做静默续期，改成用 `/users/me` 探活。
 *   - token 与采集到的凭证同等敏感，落盘前一律走 safeStorage（DPAPI），
 *     对渲染进程只回脱敏后的资料，明文 token 不出主进程。
 */
const API = {
  signIn: '/login',
  // 没有 refresh-token 接口，用「查当前用户」来验证 token 还有没有效
  me: '/users/me'
}

/** JWT 的 exp 是唯一可靠的到期时间，别按「登录时刻 + 7 天」自己估 */
function jwtExp(token) {
  try {
    const payload = String(token || '').split('.')[1]
    if (!payload) return 0
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return Number(json.exp) || 0
  } catch {
    return 0
  }
}

/** 三个权限位：决定界面上能进哪几栏，缺字段一律按「没有」处理 */
function permsOf(data) {
  const src = data || {}
  return {
    logs: Boolean(src.canViewLogs),
    orderPool: Boolean(src.canViewOrderPool),
    releases: Boolean(src.canViewReleases)
  }
}

export function expiresAtOf(token) {
  const exp = jwtExp(token)
  return exp ? new Date(exp * 1000).toISOString() : null
}


/**
 * 后台前端约定接口都在 `<host>/api` 下，用户可能只填域名、
 * 也可能把完整接口地址粘进来，统一收敛成 `https://host/api`。
 */
export function normalizeBaseUrl(input) {
  let url = String(input || '').trim()
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) {
    // 内网 / 本机地址默认走 http，公网域名走 https
    const host = url.split('/')[0]
    const isLocal =
      /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(host)
    url = (isLocal ? 'http://' : 'https://') + url
  }
  url = url.replace(/\/+$/, '')
  url = url.replace(/\/api$/i, '')
  return url + '/api'
}

/** 只保留前 3 后 4，够确认是不是同一个号，又不构成泄漏 */
export function maskPhone(phone) {
  const s = String(phone || '')
  if (s.length < 8) return s
  return s.slice(0, 3) + '****' + s.slice(-4)
}

export default class MemberAuth {
  constructor({ dir, deviceId, apiBase, onLog }) {
    this.dir = dir
    this.file = path.join(dir, 'auth.json')
    this.deviceId = deviceId || ''
    this.apiBase = normalizeBaseUrl(apiBase || resolveApiBase())
    this.onLog = onLog || (() => {})
    this.encryptionAvailable = false
    this.data = { member: null, token: null, refreshToken: null, expiresAt: null, permissions: null }
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true })
    try {
      this.encryptionAvailable = safeStorage.isEncryptionAvailable()
    } catch {
      this.encryptionAvailable = false
    }
    if (!fs.existsSync(this.file)) return this.data
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.data = { ...this.data, ...raw }
    } catch {
      this.data = { member: null, token: null, refreshToken: null, expiresAt: null, permissions: null }
    }
    return this.data
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }

  encrypt(plain) {
    if (!plain) return null
    if (this.encryptionAvailable) {
      return { enc: 'safe', value: safeStorage.encryptString(plain).toString('base64') }
    }
    return { enc: 'plain', value: Buffer.from(plain, 'utf8').toString('base64') }
  }

  decrypt(record) {
    if (!record?.value) return ''
    try {
      const buf = Buffer.from(record.value, 'base64')
      if (record.enc === 'safe') return safeStorage.decryptString(buf)
      return buf.toString('utf8')
    } catch {
      return ''
    }
  }

  /** 固定接口地址，来自 config/endpoints.js，用户不可改 */
  get baseUrl() {
    return this.apiBase
  }

  isLoggedIn() {
    return Boolean(this.data.member && this.decrypt(this.data.token))
  }

  /** 明文 token，只在主进程内部用（刷新会话、上报鉴权） */
  getToken() {
    return this.decrypt(this.data.token)
  }

  getRefreshToken() {
    return this.decrypt(this.data.refreshToken) || this.getToken()
  }

  /** 给渲染进程看的状态，绝不含 token */
  status() {
    const member = this.data.member
    return {
      loggedIn: this.isLoggedIn(),
      baseUrl: this.baseUrl,
      deviceId: this.deviceId,
      expiresAt: this.data.expiresAt || null,
      encrypted: this.encryptionAvailable,
      permissions: this.data.permissions || { logs: false, orderPool: false, releases: false },
      member: member
        ? {
            id: member.id,
            name: member.name || '',
            username: member.username || '',
            // 账号可能是手机号也可能不是，是手机号才脱敏，用户名照原样显示
            phone: member.phone ? maskPhone(member.phone) : '',
            phoneMasked: member.phone ? maskPhone(member.phone) : '',
            role: member.role || '',
            loginAt: member.loginAt || null
          }
        : null
    }
  }

  async request(pathname, body, token) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    let res
    try {
      res = await fetch(this.apiBase + pathname, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(body || {}),
        signal: controller.signal
      })
    } catch (e) {
      clearTimeout(timer)
      throw new Error(
        e.name === 'AbortError' ? '连接超时，请检查网络或服务端是否已启动' : `无法连接服务器：${e.message}`
      )
    }
    clearTimeout(timer)

    let json = null
    try {
      json = await res.json()
    } catch {
      /* 非 JSON 响应，交给下面的兜底报错 */
    }

    if (!res.ok || !json || json.success === false) {
      // ticket-server 的错误字段叫 error，不是 message；两个都认，兜底给 HTTP 状态码
      const message = json?.error || json?.message || `HTTP ${res.status}`
      const err = new Error(message)
      err.status = res.status
      throw err
    }
    // 登录接口的响应是扁平的（token/id/username 直接在顶层），
    // 业务接口才包 data —— 这里原样返回，由调用方自己取。
    return json
  }

  /**
   * 只读 GET 接口（影城、账号这类查询），自动带会员 token。
   * 与 request 的差别只是方法和 body —— 服务端同一套响应包。
   */
  async get(pathname) {
    const token = this.getToken()
    if (!token) throw new Error('未登录')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    let res
    try {
      res = await fetch(this.apiBase + pathname, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal
      })
    } catch (e) {
      clearTimeout(timer)
      throw new Error(
        e.name === 'AbortError' ? '连接超时，请检查网络或服务端是否已启动' : `无法连接服务器：${e.message}`
      )
    }
    clearTimeout(timer)

    let json = null
    try {
      json = await res.json()
    } catch {
      /* 非 JSON 响应，交给下面的兜底报错 */
    }

    if (!res.ok || !json || json.success === false) {
      const err = new Error(json?.error || json?.message || `HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return json.data || {}
  }

  /**
   * 登录。接口地址编译期固定，登录框收「用户名 + 密码」：
   * 后台按 username 查用户，手机号也能当 username 用（账号本身就是手机号时行为不变）。
   * 密码不落盘，token 落盘前加密。
   */
  async signIn({ username, phone, password }) {
    const account = String(username || phone || '').trim()
    if (!account || !password) throw new Error('请填写用户名和密码')

    const data = await this.request(API.signIn, {
      username: account,
      password: String(password)
    })

    const token = data.token || data.accessToken || ''
    if (!token) throw new Error('登录响应里没有 token')

    // 账号是手机号才留 phone（界面按 138****6666 展示），否则只认用户名
    const asPhone = /^1\d{10}$/.test(account)
    this.data.member = {
      id: data.id,
      name: data.username || account,
      username: data.username || account,
      phone: asPhone ? account : '',
      role: data.role || '',
      loginAt: new Date().toISOString()
    }
    this.data.permissions = permsOf(data)
    this.data.token = this.encrypt(token)
    // 服务端没有 refresh 接口，refreshToken 不再单独保存
    this.data.refreshToken = null
    // 到期时间取 JWT 里的 exp，读不到才退回「7 天后」
    this.data.expiresAt =
      expiresAtOf(token) || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
    this.save()

    this.onLog('info', `账号已登录：${this.data.member.name}`)
    return this.status()
  }

  /**
   * 没有 refresh-token 接口，所以「续期」退化成探活：
   * 拿当前 token 请求一次 /users/me，通就刷新本地到期时间，401/403 就当掉线。
   */
  async refresh() {
    if (!this.getToken()) throw new Error('未登录')

    try {
      const me = await this.get(API.me)
      if (me?.username) {
        this.data.member = {
          ...this.data.member,
          id: me.id ?? this.data.member?.id,
          name: me.username,
          username: me.username,
          role: me.role || this.data.member?.role || ''
        }
      }
      // 权限位以后台为准：/users/me 也会回，管理员改过权限后探活就能跟上
      if (me && ('canViewLogs' in me || 'canViewOrderPool' in me || 'canViewReleases' in me)) {
        this.data.permissions = permsOf(me)
      }
      // 到期时间仍取 token 自己的 exp，探活不会延长 JWT
      this.data.expiresAt =
        expiresAtOf(this.getToken()) ||
        this.data.expiresAt ||
        new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
      this.save()
      return this.status()
    } catch (e) {
      if (e.status === 401 || e.status === 403) this.clear(e.message)
      throw e
    }
  }

  /**
   * 服务端没有 sign_out 接口（JWT 无状态，签发即生效到过期），
   * 退出就是清本地凭证 —— 反正明文 token 只存在本机的 DPAPI 加密文件里。
   */
  async signOut() {
    this.clear()
    return this.status()
  }

  clear(reason) {
    const name = this.data.member?.name || ''
    this.data.member = null
    this.data.token = null
    this.data.refreshToken = null
    this.data.expiresAt = null
    this.data.permissions = null
    this.save()
    if (reason) this.onLog('warn', `账号登录已失效：${reason}`)
    else if (name) this.onLog('info', `账号已退出：${name}`)
  }
}
