import { reactive } from 'vue'
import { invoke } from '@utils/ipc'
import { refreshProxyStatus } from './proxy'

/**
 * 根证书状态。
 *
 * 状态栏和设置页都要显示「已安装 / 未安装」，而且任一处装了或卸了，另一处必须立刻跟着变 ——
 * 之前两边各存一份，从设置页卸载后状态栏还挂着「已安装」，看起来像卸载失败。
 * 所以收敛成一个单例，装/卸/刷新都从这里走。
 */
export const caInfo = reactive({
  installed: false,
  fingerprint: '',
  notAfter: null,
  /** 是否成功读到过一次：没读到之前不要断言「未安装」 */
  loaded: false
})

/** 重新问一遍主进程。用户在 certmgr 里手动删证书时，靠这个把界面拉回真实状态 */
export async function refreshCa() {
  try {
    const res = await invoke('ca:info')
    caInfo.installed = Boolean(res?.installed)
    caInfo.fingerprint = res?.fingerprint || ''
    caInfo.notAfter = res?.notAfter || null
  } catch {
    /* 读不到就保持上一次的值，别把已安装误显示成未安装 */
  } finally {
    caInfo.loaded = true
  }
  return caInfo
}

/** 安装并复核。主进程自己会用指纹再查一遍，这里只负责把状态同步回来 */
export async function installCa() {
  const res = await invoke('ca:install')
  await refreshCa()
  return res
}

/** 卸载并复核。失败（证书还在）时 ok 为 false，调用方要把消息提示出来 */
export async function uninstallCa() {
  const res = await invoke('ca:uninstall')
  await refreshCa()
  // 主进程卸载成功会顺手停掉采集，这里立刻同步运行状态，别等下一轮轮询才变灰
  await refreshProxyStatus()
  return res
}
