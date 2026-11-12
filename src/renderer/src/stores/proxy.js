import { reactive } from 'vue'
import { invoke } from '@utils/ipc'

/**
 * 采集（代理）运行状态。
 *
 * 标题栏的播放/暂停图标和底部状态栏的指示灯都要读它，所以放成全局单例，
 * 由 layout 统一启停轮询 —— 两个组件各自轮询会打双份 IPC。
 */
export const proxyStatus = reactive({
  running: false,
  port: 0,
  /** 累计解密 / 直通计数，设置页的采集状态卡片要用 */
  stats: { intercepted: 0, tunneled: 0 },
  /**
   * 上游代理（Clash / V2Ray 之类）：接管系统代理前指向谁，就把谁当上游。
   * null 表示直连出网。抓不到包时这是第一个要看的信息。
   */
  upstream: null,
  /** 正在切换：图标要禁用，避免连点把代理来回切 */
  busy: false
})

let timer = null

async function poll() {
  try {
    const s = await invoke('proxy:status')
    proxyStatus.running = Boolean(s?.running)
    proxyStatus.port = s?.port || 0
    proxyStatus.stats = s?.stats || { intercepted: 0, tunneled: 0 }
    proxyStatus.upstream = s?.upstream || null
  } catch {
    /* 轮询失败保留上一次状态，不打扰用户 */
  }
}

export function startProxyPoll() {
  if (timer) return
  poll()
  // 主进程没有状态变更推送，3 秒一次开销可忽略
  timer = setInterval(poll, 3000)
}

export function stopProxyPoll() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export async function refreshProxyStatus() {
  await poll()
}

/** 开始 / 停止采集。返回主进程给的结果（含错误文案），由调用方决定怎么提示 */
export async function toggleProxy() {
  if (proxyStatus.busy) return null
  proxyStatus.busy = true
  try {
    const res = proxyStatus.running ? await invoke('proxy:stop') : await invoke('proxy:start')
    await poll()
    return res
  } finally {
    proxyStatus.busy = false
  }
}
