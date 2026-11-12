import { reactive } from 'vue'

/**
 * 全局界面状态。
 *
 * 设置从独立页面改成弹窗后，不止齿轮要能唤起它 —— 状态栏的「证书 未安装」
 * 也应该直接落到「根证书」那一栏。用一个共享单例，省得层层传事件。
 */
export const ui = reactive({
  settingsOpen: false,
  /** 打开时落在哪一栏：general / account / status / credentials / reporter / logs / ca / about */
  settingsSection: 'general',
  /**
   * 主视图：cinemas 影城账号 / platform 接单平台账号。
   * 用 v-show 切而不是卸载页面，切回来时筛选条件、选中的出票系统都还在。
   */
  mode: 'cinemas'
})

/**
 * 打开设置。
 * 不传 section 就停在上次看的那一栏 —— 齿轮是个「回到设置」的入口，
 * 每次都弹回「通用」反而要多点一次。状态栏那类明确入口才指定 section。
 */
export function openSettings(section) {
  if (section) ui.settingsSection = section
  ui.settingsOpen = true
}

/** 影城账号 ↔ 接单平台账号 */
export function toggleMode() {
  ui.mode = ui.mode === 'cinemas' ? 'platform' : 'cinemas'
}
