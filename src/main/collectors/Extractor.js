/**
 * 声明式抓取规则引擎。
 *
 * 设计目标：新增一套影城系统时只写配置，不改代码。
 * 每条规则描述三件事 —— 抓谁的流量、从哪取凭证、凭证怎么算过期。
 *
 * 之所以不用「每个系统写一个 class」，是因为这几家系统的差异几乎都在
 * 接口路径和字段名上，用配置表达比用继承表达更省事，也更好让运营自己维护。
 */

import { isBypassHost } from '../mitm/hostBypass.js'

/**
 * @typedef {Object} CaptureRule
 * @property {string}  id            唯一标识
 * @property {string}  name          显示名
 * @property {boolean} enabled
 * @property {string[]} hosts        命中即解密的域名，支持 *.example.com
 * @property {Object}  capture
 * @property {Array}   capture.fromResponse      从登录响应提取
 * @property {string[]} capture.fromRequestHeader 从请求头被动提取
 * @property {Object}  expiry
 */

export default class Extractor {
  constructor(rules = []) {
    /** 「获取参数」时按影城入口链接临时放行的域名，不属于任何正式规则 */
    this.extraHosts = []
    /**
     * 全量解密开关：只有「小程序采集」这一条路会打开它。
     *
     * H5 采集有入口链接，域名能从链接推出来；小程序跑在微信里，我们既没有链接，
     * 也不可能有二十多套系统的接口域名清单。既然配不全，就干脆全解开、靠字段名匹配捞值，
     * 例外表见 mitm/hostBypass.js（微信自身、系统更新、杀毒、银行一律不断只透传）。
     */
    this.openCapture = false
    this.setRules(rules)
  }

  /** 开关必须显式关掉：留着它等于把客户机所有 HTTPS 长期解开 */
  setOpenCapture(on) {
    this.openCapture = Boolean(on)
  }

  setRules(rules) {
    this.rules = (rules || []).filter((r) => r && r.enabled !== false)
  }

  get activeRules() {
    return this.rules
  }

  /**
   * 按入口链接临时放行要解密的域名。
   *
   * 为什么需要：规则是「按出票系统」写的，但同一个系统几十家影城各有一条入口链接，
   * 链接域名往往不在规则里（甚至连后端接口都在另一个子域）。没有这条，
   * 代理只会把流量原样隧道转发，页面上再怎么登录也抓不到一个字节。
   */
  allowHosts(patterns = []) {
    const merged = new Set(this.extraHosts || [])
    for (const pattern of patterns) {
      if (pattern) merged.add(String(pattern).toLowerCase())
    }
    this.extraHosts = [...merged]
  }

  clearExtraHosts() {
    this.extraHosts = []
  }

  /**
   * 供 MitmProxy 判定是否需要解密。任一规则或临时放行的入口域名命中即解密。
   * 返回值只用来判真假，入口临时域名给一个占位对象便于日志排查。
   */
  matchHost(host) {
    if (!host) return null
    for (const rule of this.rules) {
      if (this.hostMatches(rule, host)) return rule
    }
    if ((this.extraHosts || []).some((pattern) => matchDomain(pattern, host))) {
      return { id: '__entry__', name: '影城入口链接', hosts: this.extraHosts }
    }
    if (this.openCapture && !isBypassHost(host)) {
      return { id: '__open__', name: '小程序全量解密', hosts: ['*'] }
    }
    return null
  }

  hostMatches(rule, host) {
    const list = rule.hosts || []
    return list.some((pattern) => matchDomain(pattern, host))
  }

  /**
   * 从一条抓包记录里提取凭证。
   * @returns {{ruleId:string, token:string, account?:string, expiresAt?:number, source:string}|null}
   */
  extract(record) {
    if (!record) return null

    for (const rule of this.rules) {
      if (!this.hostMatches(rule, record.host)) continue

      const fromResponse = this.extractFromResponse(rule, record)
      if (fromResponse) return fromResponse

      const fromHeader = this.extractFromRequestHeader(rule, record)
      if (fromHeader) return fromHeader
    }

    return null
  }

  extractFromResponse(rule, record) {
    const defs = rule.capture?.fromResponse || []
    if (!defs.length || !record.resBody) return null

    const body = parseJsonSafe(record.resBody)
    if (!body) return null

    const method = String(record.method || '').toUpperCase()
    const path = record.path || ''

    for (const def of defs) {
      const when = def.when || {}
      if (when.method && String(when.method).toUpperCase() !== method) continue
      if (when.pathIncludes && !when.pathIncludes.some((p) => path.includes(p))) continue
      if (when.pathExcludes && when.pathExcludes.some((p) => path.includes(p))) continue

      const token = firstPick(body, def.tokenPaths)
      if (!token) continue

      return {
        ruleId: rule.id,
        token: String(token),
        account: firstPick(body, def.accountPaths || []) || undefined,
        expiresAt: this.resolveExpiry(rule, body, def),
        extra: pickExtra(body, def.extraPaths),
        source: `${record.method} ${path}`,
        at: record.at
      }
    }

    return null
  }

  /**
   * 有些系统只在「携带 token 的正常业务请求」里出现凭证，
   * 登录接口反而拿不到。这类走请求头被动采集。
   */
  extractFromRequestHeader(rule, record) {
    const keys = rule.capture?.fromRequestHeader || []
    if (!keys.length || !record.reqHeaders) return null

    const headers = record.reqHeaders
    for (const key of keys) {
      const value = headers[key] || headers[key.toLowerCase()]
      if (!value) continue
      // 鉴权头通常写成 "Bearer xxx"，存进去的时候必须把前缀剥掉，
      // 否则上报给服务端的就是一段带前缀的废值
      const token = String(value).replace(/^bearer\s+/i, '').trim()
      // 过滤掉明显不是凭证的短值（例如 token 字段被置空、占位符）
      if (token.length < 8) continue
      return {
        ruleId: rule.id,
        token,
        source: `${record.method} ${record.path} (header:${key})`,
        at: record.at,
        expiresAt: null
      }
    }

    return null
  }

  resolveExpiry(rule, body, def) {
    const expiry = rule.expiry || {}

    if (def.expirePaths?.length) {
      const raw = firstPick(body, def.expirePaths)
      if (raw != null) {
        const num = Number(raw)
        if (Number.isFinite(num)) {
          // 超过 1e12 视为毫秒时间戳，超过 1e9 视为秒级时间戳，否则视为秒数存活期
          if (num > 1e12) return num
          if (num > 1e9) return num * 1000
          return Date.now() + num * 1000
        }
        const parsed = Date.parse(raw)
        if (Number.isFinite(parsed)) return parsed
      }
    }

    if (expiry.type === 'sliding' && expiry.idleSeconds) {
      // 滑动续期：只要有心跳就不会死，过期时间按「最后一次成功心跳 + 闲置窗口」估算
      return Date.now() + expiry.idleSeconds * 1000
    }

    if (expiry.defaultSeconds) {
      return Date.now() + expiry.defaultSeconds * 1000
    }

    return null
  }
}

/**
 * 域名匹配：支持精确、*. 通配、以及不带 * 的父域匹配。
 */
export function matchDomain(pattern, host) {
  if (!pattern || !host) return false
  const p = pattern.toLowerCase().trim()
  const h = host.toLowerCase().trim()

  if (p === h) return true
  if (p.startsWith('*.')) {
    const suffix = p.slice(1) // .example.com
    return h.endsWith(suffix) && h.length > suffix.length
  }
  // 未写通配符时，允许子域命中父域写法
  return h.endsWith('.' + p)
}

export function pick(obj, path) {
  if (!obj || !path) return undefined
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined
    return acc[key]
  }, obj)
}

export function firstPick(obj, paths = []) {
  for (const path of paths) {
    const value = pick(obj, path)
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/**
 * 提取主凭证之外的附加字段。
 *
 * 有些系统光有 token 不够用 —— 鲸鱼系统还得同时交出 refreshToken，
 * 少了它服务端没法续期，token 一到期就只能等人工重新登录。
 * 规则里用 extraPaths: { refreshToken: ['data.refreshToken'] } 声明。
 *
 * @returns {Object<string, string>} 没命中的字段不出现在结果里
 */
export function pickExtra(body, extraPaths = {}) {
  const out = {}
  for (const [key, paths] of Object.entries(extraPaths || {})) {
    const value = firstPick(body, paths)
    if (value === undefined || value === null || value === '') continue
    out[key] = String(value)
  }
  return out
}

export function parseJsonSafe(text) {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}
