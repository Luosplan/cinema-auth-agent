import { reactive } from 'vue'
import { invoke, on } from '@utils/ipc'

/**
 * 自动更新状态。
 *
 * 主进程启动时静默检查一次，检测到新版本就通过 `updater-event` 广播回来，
 * 标题栏据此亮「立即更新」按钮。下载进度也走同一个通道。
 */
export const updaterStatus = reactive({
  enabled: false,
  available: false,
  version: '',
  downloading: false,
  progress: 0,
  downloaded: false,
  error: ''
})

let off = null

async function refresh() {
  try {
    const s = await invoke('updater:status')
    if (!s) return
    updaterStatus.enabled = Boolean(s.enabled)
    updaterStatus.available = Boolean(s.available)
    updaterStatus.version = s.version || ''
    updaterStatus.downloading = Boolean(s.downloading)
    updaterStatus.progress = s.progress || 0
    updaterStatus.downloaded = Boolean(s.downloaded)
    updaterStatus.error = s.error || ''
  } catch {
    /* 更新模块读不到就不打扰 */
  }
}

export function startUpdaterListen() {
  if (off) return
  off = on('updater-event', (payload) => {
    const type = payload?.type
    if (type === 'available') {
      updaterStatus.available = true
      updaterStatus.version = payload.version || ''
    } else if (type === 'progress') {
      updaterStatus.downloading = true
      updaterStatus.progress = payload.percent || 0
    } else if (type === 'downloaded') {
      updaterStatus.downloaded = true
      updaterStatus.downloading = false
      updaterStatus.progress = 100
    } else if (type === 'error') {
      updaterStatus.error = payload.message || ''
      updaterStatus.downloading = false
    } else if (type === 'not-available') {
      updaterStatus.available = false
    }
  })
  refresh()
}

export function stopUpdaterListen() {
  if (off) {
    off()
    off = null
  }
}

export async function downloadUpdate() {
  return invoke('updater:download')
}
