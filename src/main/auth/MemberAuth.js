import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { resolveApiBase } from '../config/endpoints.js'

/**
 * 会员账号登录（凭证采集端的「我是谁」）。
 *
 * 复用服务端现成的会员登录接口（`/api/public/login/web/*`），
 * 不做任何自建账号体系：
 *   - 服务端是单设备登录模型 —— 同一账号后登录会踢掉先登录，
 *     同一设备后登录会踢掉先登录的账号，所以 deviceId 必须固化，
 *     这里直接复用 reporter 的 agentId（首次生成后写在 agent.json 里）。
 *   - token 与采集到的凭证同等敏感，落盘前一律走 safeStorage（DPAPI），
 *     对渲染进程只回脱敏后的资料，明文 token 不出主进程。
 */
const API = {
  signIn: '/public/login/web/sign_in',
  refresh: '/public/login/web/refresh-token',
  signOut: '/public/login/web/sign_out'
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
    this.data = { member: null, token: null, refreshToken: null, expiresAt: null }
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
      this.data = { member: null, token: null, refreshToken: null, expiresAt: null }
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
      member: member
        ? {
            id: member.id,
            name: member.name || '',
            phone: maskPhone(member.phone),
            phoneMasked: member.phone ? maskPhone(member.phone) : '',
            systemCount: (member.systemIds || []).length,
            cinemaGroupCount: (member.cinemaGroupIds || []).length,
            loginAt: member.loginAt || null
          }
        : null
    }
  }

  async request(pathname, body, token, method = 'POST') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    let res
    try {
      res = await fetch(this.apiBase + pathname, {
        method,
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
      const message = json?.message || `HTTP ${res.status}`
      const err = new Error(message)
      err.status = res.status
      throw err
    }
    return json.data || {}
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
      const err = new Error(json?.message || `HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return json.data || {}
  }

  /**
   * 写接口（当前只有保存出票程序入口），自动带会员 token。
   * 目标接口就是后台现成的「编辑出票程序」，响应包一致，直接复用。
   */
  async put(pathname, body) {
    const token = this.getToken()
    if (!token) throw new Error('未登录')
    return this.request(pathname, body, token, 'PUT')
  }

  /**
   * 登录。接口地址是编译期固定的会员端地址，登录框只收手机号与密码，密码不落盘。
   */
  async signIn({ phone, password }) {
    if (!phone || !password) throw new Error('请填写手机号和密码')

    const data = await this.request(API.signIn, {
      phone: String(phone).trim(),
      password: String(password),
      deviceId: this.deviceId
    })

    const token = data.accessToken || data.token || ''
    if (!token) throw new Error('登录响应里没有 token')

    this.data.member = {
      id: data.id,
      name: data.name || '',
      phone: data.phone || phone,
      systemIds: data.systemIds || [],
      cinemaGroupIds: data.cinemaGroupIds || [],
      loginAt: new Date().toISOString()
    }
    this.data.token = this.encrypt(token)
    // 服务端 sign_in 同时返回 token 与 accessToken，两者相同；
    // refresh-token 接口也正是用它当 refreshToken 校验 type === 'member'
    this.data.refreshToken = this.encrypt(data.refreshToken || token)
    this.data.expiresAt = data.expires || null
    this.save()

    this.onLog('info', `会员账号已登录：${this.data.member.name || maskPhone(phone)}`)
    return this.status()
  }

  /** token 过期时静默续期；失败即视为掉线 */
  async refresh() {
    const refreshToken = this.getRefreshToken()
    if (!refreshToken) throw new Error('未登录')

    try {
      const data = await this.request(API.refresh, { refreshToken })
      const token = data.accessToken || data.token || ''
      if (token) {
        this.data.token = this.encrypt(token)
        this.data.refreshToken = this.encrypt(token)
      }
      if (data.expires) this.data.expiresAt = data.expires
      this.save()
      return this.status()
    } catch (e) {
      if (e.status === 401 || e.status === 403) this.clear(e.message)
      throw e
    }
  }

  async signOut() {
    const token = this.getToken()
    if (token) {
      // 退出失败（网络不通、token 已过期）不阻塞本地清理
      await this.request(API.signOut, { token }, token).catch(() => {})
    }
    this.clear()
    return this.status()
  }

  clear(reason) {
    const name = this.data.member?.name || ''
    this.data.member = null
    this.data.token = null
    this.data.refreshToken = null
    this.data.expiresAt = null
    this.save()
    if (reason) this.onLog('warn', `会员登录已失效：${reason}`)
    else if (name) this.onLog('info', `会员账号已退出：${name}`)
  }
}
