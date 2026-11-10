import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 凭证上报到云端。
 *
 * 设计约束：
 *   - 默认关闭。客户没配云端地址时，软件纯本地工作，不向外发任何数据。
 *   - 上报失败绝不阻塞采集，失败记录进队列等下次重试，队列上限防止内存膨胀。
 *   - 同一系统在 minIntervalSec 内只上报一次，避免客户连续操作时刷屏。
 */
export default class Reporter {
  constructor({ configStore, credentialStore, dir, onLog, version }) {
    this.configStore = configStore
    this.credentialStore = credentialStore
    this.dir = dir
    this.onLog = onLog || (() => {})
    this.version = version || ''
    this.queue = []
    this.lastSentAt = new Map()
    this.agentId = this.loadAgentId()
  }

  /**
   * 设备标识：首次生成后固化，云端用它区分是哪一台客户机。
   */
  loadAgentId() {
    const file = path.join(this.dir, 'agent.json')
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (data.agentId) return data.agentId
      }
    } catch {
      /* 损坏则重新生成 */
    }
    const agentId = randomUUID()
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ agentId }, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
    return agentId
  }

  getConfig() {
    return this.configStore.get('reporter') || {}
  }

  isEnabled() {
    const cfg = this.getConfig()
    return Boolean(cfg.enabled && cfg.url)
  }

  /**
   * @param {object} payload 含明文 token 的对象
   */
  async push(payload) {
    if (!this.isEnabled()) return { sent: false, reason: 'disabled' }

    const cfg = this.getConfig()
    const now = Date.now()
    const last = this.lastSentAt.get(payload.ruleId) || 0
    const minGap = (cfg.minIntervalSec || 30) * 1000

    if (now - last < minGap) {
      return { sent: false, reason: 'throttled' }
    }

    this.lastSentAt.set(payload.ruleId, now)
    return this.send(payload)
  }

  async send(payload) {
    const cfg = this.getConfig()
    const body = {
      agentId: this.agentId,
      ruleId: payload.ruleId,
      taskName: payload.taskName,
      account: payload.account,
      token: payload.token,
      // 附加字段（如鲸鱼系统的 refreshToken）随凭证一起上报，否则云端续不了期
      extras: payload.extras || null,
      expiresAt: payload.expiresAt,
      updatedAt: payload.updatedAt,
      source: payload.source,
      platform: process.platform,
      version: this.version
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.token ? { 'x-agent-token': cfg.token } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      clearTimeout(timer)

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }

      this.onLog('info', `已上报 ${payload.taskName || payload.ruleId}`)
      return { sent: true }
    } catch (e) {
      this.enqueue(body)
      this.onLog('warn', `上报失败 ${payload.ruleId}: ${e.message}`)
      return { sent: false, reason: e.message }
    }
  }

  enqueue(body) {
    this.queue.push(body)
    if (this.queue.length > 50) this.queue.shift()
  }

  /**
   * 网络恢复后补发。由外部定时器调用。
   */
  async flush() {
    if (!this.isEnabled() || !this.queue.length) return
    const pending = this.queue.splice(0, this.queue.length)
    for (const body of pending) {
      try {
        await this.send(body)
      } catch {
        this.enqueue(body)
      }
    }
  }

  /**
   * 手动测试连通性，界面上的「测试连接」按钮用。
   */
  async test() {
    if (!this.isEnabled()) return { ok: false, message: '未配置上报地址或未启用' }
    const cfg = this.getConfig()
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.token ? { 'x-agent-token': cfg.token } : {})
        },
        body: JSON.stringify({ agentId: this.agentId, ping: true }),
        signal: controller.signal
      })
      clearTimeout(timer)
      return { ok: res.ok, message: `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, message: e.message }
    }
  }
}
