import { reactive } from 'vue'

/**
 * 全局的「打开设置」入口。
 *
 * 设置从独立页面改成弹窗后，不止齿轮要能唤起它 —— 状态栏的「证书 未安装」
 * 也应该直接落到「根证书」那一栏。用一个共享单例，省得层层传事件。
 */
export const ui = reactive({
  settingsOpen: false,
  /** 打开时落在哪一栏：general / account / status / credentials / reporter / logs / ca / about */
  settingsSection: 'general'
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
