/**
 * 与主进程通信的统一入口。
 *
 * 全项目只有这一个地方直接碰 ipcRenderer，其余页面都走 invoke / on。
 * 这样将来要换协议（比如换成 contextBridge 白名单）只需要改这一个文件。
 */
const RENDERER_CHANNEL = 'renderer-to-main-invoke'

export function invoke(name, params = {}) {
  return window.electron.ipcRenderer.invoke(RENDERER_CHANNEL, { name, params })
}

export function on(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  window.electron.ipcRenderer.on(channel, listener)
  return () => window.electron.ipcRenderer.removeListener(channel, listener)
}
