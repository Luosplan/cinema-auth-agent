import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'

/**
 * 凭证仓库。
 *
 * 安全约定（不可妥协）：
 *   - token 落盘前必须经 safeStorage 加密（Windows 走 DPAPI，绑定当前用户）。
 *   - 对界面只暴露脱敏值和过期时间，永远不把明文 token 传回渲染进程。
 *   - 明文只在两处出现：上报给云端时的内存变量、以及用户主动点击「复制」的瞬间。
 *
 * 这是客户机器上最敏感的东西 —— 它等同于客户的微信身份，
 * 一旦泄漏等于把客户的影城账号交出去。
 */
export default class CredentialStore {
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, 'credentials.json')
    this.data = {}
    this.encryptionAvailable = false
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
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this.data = {}
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
    if (this.encryptionAvailable) {
      return { enc: 'safe', value: safeStorage.encryptString(plain).toString('base64') }
    }
    // 极端兜底：系统不支持加密时仍然落盘，但明确标记，界面上会提示风险
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

  /**
   * 写入或更新一条凭证。token 未变化时不重复落盘。
   *
   * extra 是主凭证之外的附加字段（目前只有鲸鱼系统的 refreshToken 用到），
   * 与 token 同等敏感，同样逐字段加密落盘，绝不回传渲染进程。
   *
   * @returns {{changed:boolean, entry:object}}
   */
  upsert({ ruleId, taskName, account, token, expiresAt, source, at, extra }) {
    if (!ruleId || !token) return { changed: false, entry: null }

    const prev = this.data[ruleId]
    const prevToken = prev ? this.decrypt(prev.token) : ''
    const nextExtra = extra && Object.keys(extra).length ? extra : null
    const prevExtra = prev ? this.decryptExtra(prev) : null

    const sameExtra = JSON.stringify(prevExtra || null) === JSON.stringify(nextExtra || null)
    if (prevToken === token && prev?.expiresAt === expiresAt && sameExtra) {
      return { changed: false, entry: this.mask(prev) }
    }

    const entry = {
      ruleId,
      taskName: taskName || prev?.taskName || ruleId,
      account: account || prev?.account || '',
      token: this.encrypt(token),
      extra: nextExtra ? this.encryptExtra(nextExtra) : null,
      expiresAt: expiresAt || null,
      source: source || '',
      updatedAt: at || new Date().toISOString(),
      firstSeenAt: prev?.firstSeenAt || at || new Date().toISOString()
    }

    this.data[ruleId] = entry
    this.save()
    return { changed: true, entry: this.mask(entry) }
  }

  encryptExtra(extra) {
    const out = {}
    for (const [key, value] of Object.entries(extra)) {
      out[key] = this.encrypt(String(value))
    }
    return out
  }

  decryptExtra(entry) {
    if (!entry?.extra) return null
    const out = {}
    for (const [key, record] of Object.entries(entry.extra)) {
      const plain = this.decrypt(record)
      if (plain) out[key] = plain
    }
    return Object.keys(out).length ? out : null
  }

  /**
   * 明文 token + 附加字段，仅限上报与内部使用。
   */
  getToken(ruleId) {
    const entry = this.data[ruleId]
    if (!entry) return null
    return { ...this.mask(entry), token: this.decrypt(entry.token), extras: this.decryptExtra(entry) }
  }

  list() {
    return Object.values(this.data).map((entry) => this.mask(entry))
  }

  remove(ruleId) {
    if (!this.data[ruleId]) return false
    delete this.data[ruleId]
    this.save()
    return true
  }

  mask(entry) {
    if (!entry) return null
    const plain = this.decrypt(entry.token)
    return {
      ruleId: entry.ruleId,
      taskName: entry.taskName,
      account: entry.account,
      tokenMasked: maskToken(plain),
      tokenLength: plain.length,
      // 附加字段只回「有哪些」和脱敏预览，明文一律不出主进程
      extraKeys: Object.keys(entry.extra || {}),
      extrasMasked: this.maskExtra(entry),
      expiresAt: entry.expiresAt || null,
      source: entry.source,
      updatedAt: entry.updatedAt,
      firstSeenAt: entry.firstSeenAt,
      encrypted: entry.token?.enc === 'safe'
    }
  }

  maskExtra(entry) {
    const extras = this.decryptExtra(entry)
    if (!extras) return {}
    const out = {}
    for (const [key, value] of Object.entries(extras)) out[key] = maskToken(value)
    return out
  }
}

/**
 * 只留下前 6 位和后 4 位，中间用 * 填充。
 * 足够让运营确认「是不是同一张凭证」，又不构成泄漏。
 */
export function maskToken(token) {
  if (!token) return ''
  const s = String(token)
  if (s.length <= 12) return s.slice(0, 2) + '****'
  return `${s.slice(0, 6)}...${s.slice(-4)}`
}
