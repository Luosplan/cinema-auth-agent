import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * 自动更新封装。
 *
 * 策略：
 *   - 检测到新版本不自动下载，只在界面显示「立即更新」按钮；
 *   - 用户点击后才下载，并实时回报下载进度；
 *   - 下载完成后先停采集、还原系统代理，再静默安装并自动重启。
 *
 * 开发模式没有 app-update.yml，直接跳过检查。
 */
export default class Updater {
  constructor({ onEvent, beforeInstall }) {
    this.onEvent = onEvent || (() => {})
    this.beforeInstall = beforeInstall || (() => Promise.resolve())
    this.available = false
    this.version = ''
    this.downloading = false
    this.progress = 0
    this.downloaded = false
    this.error = ''

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.autoRunAppAfterInstall = true
    autoUpdater.allowPrerelease = false

    autoUpdater.on('checking-for-update', () => this._emit('checking'))
    autoUpdater.on('update-available', (info) => {
      this.available = true
      this.version = String(info.version || '')
      this.error = ''
      this._emit('available', { version: this.version })
    })
    autoUpdater.on('update-not-available', () => this._emit('not-available'))
    autoUpdater.on('download-progress', (p) => {
      this.downloading = true
      this.progress = Number(p.percent) || 0
      this._emit('progress', {
        percent: this.progress,
        transferred: p.transferred,
        total: p.total,
        bytesPerSecond: p.bytesPerSecond
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.downloaded = true
      this.downloading = false
      this.progress = 100
      this._emit('downloaded', { version: String(info.version || '') })
      // 稍停让界面把「下载完成」显示出来，再清理并重启安装
      setTimeout(() => {
        Promise.resolve(this.beforeInstall())
          .catch(() => {})
          .finally(() => this.quitAndInstall())
      }, 1200)
    })
    autoUpdater.on('error', (e) => {
      this.error = String(e?.message || e || '')
      this.downloading = false
      this._emit('error', { message: this.error })
    })
  }

  _emit(type, payload = {}) {
    try {
      this.onEvent(type, payload)
    } catch {
      /* 事件分发失败不影响更新主流程 */
    }
  }

  get enabled() {
    return app.isPackaged
  }

  async check() {
    if (!this.enabled) return { ok: false, skipped: true, message: '开发模式不检查更新' }
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (e) {
      this.error = String(e?.message || e)
      this._emit('error', { message: this.error })
      return { ok: false, message: this.error }
    }
  }

  async download() {
    if (!this.available || this.downloading) return { ok: false, message: '当前没有可下载的更新' }
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (e) {
      this.error = String(e?.message || e)
      this._emit('error', { message: this.error })
      return { ok: false, message: this.error }
    }
  }

  quitAndInstall() {
    try {
      autoUpdater.quitAndInstall(true, true)
    } catch {
      /* 安装器启动失败时交由 error 事件或下次启动兜底 */
    }
  }

  status() {
    return {
      enabled: this.enabled,
      available: this.available,
      version: this.version,
      downloading: this.downloading,
      progress: this.progress,
      downloaded: this.downloaded,
      error: this.error
    }
  }
}
