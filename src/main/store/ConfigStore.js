import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_CONFIG = {
  proxy: {
    port: 9090,
    autoStart: false
  },
  reporter: {
    enabled: false,
    url: '',
    token: '',
    minIntervalSec: 30
  },
  app: {
    autoLaunch: false,
    minimizeToTray: true,
    captureLimit: 300
  },
  rules: {}
}

/**
 * 配置文件读写。所有写入都走「先写临时文件再 rename」，
 * 避免客户机断电时留下半个 JSON 导致下次启动直接崩溃。
 */
export default class ConfigStore {
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, 'config.json')
    this.data = { ...DEFAULT_CONFIG }
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true })
    if (!fs.existsSync(this.file)) {
      this.save()
      return this.data
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.data = {
        ...DEFAULT_CONFIG,
        ...raw,
        proxy: { ...DEFAULT_CONFIG.proxy, ...(raw.proxy || {}) },
        reporter: { ...DEFAULT_CONFIG.reporter, ...(raw.reporter || {}) },
        app: { ...DEFAULT_CONFIG.app, ...(raw.app || {}) },
        rules: raw.rules || {}
      }
    } catch {
      // 配置损坏时保留坏文件便于排查，然后重置
      try {
        fs.renameSync(this.file, this.file + '.broken')
      } catch {
        /* ignore */
      }
      this.data = { ...DEFAULT_CONFIG }
      this.save()
    }
    return this.data
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }

  get(keyPath) {
    return keyPath
      .split('.')
      .reduce((acc, key) => (acc == null ? undefined : acc[key]), this.data)
  }

  set(keyPath, value) {
    const keys = keyPath.split('.')
    const last = keys.pop()
    let target = this.data
    for (const key of keys) {
      if (typeof target[key] !== 'object' || target[key] === null) target[key] = {}
      target = target[key]
    }
    target[last] = value
    this.save()
    return value
  }

  update(patch = {}) {
    // rules 按系统 id 做深合并，避免前端只改一个系统时把其他系统的配置冲掉
    const mergedRules = { ...this.data.rules }
    for (const [id, rulePatch] of Object.entries(patch.rules || {})) {
      mergedRules[id] = { ...(mergedRules[id] || {}), ...rulePatch }
    }

    this.data = {
      ...this.data,
      ...patch,
      proxy: { ...this.data.proxy, ...(patch.proxy || {}) },
      reporter: { ...this.data.reporter, ...(patch.reporter || {}) },
      app: { ...this.data.app, ...(patch.app || {}) },
      rules: mergedRules
    }
    this.save()
    return this.data
  }
}
