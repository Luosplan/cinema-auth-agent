import { reactive } from 'vue'

/**
 * 底部状态栏左下角的统计。
 *
 * 数据源在影城页（cinemas:tree + 逐个影城拉账号），状态栏自己再去拉一遍毫无意义，
 * 所以由影城页写、状态栏读。离开影城页时保留最后一次的值，不回零 ——
 * 否则切到设置页底栏会突然变成「共 0 家影城」。
 */
export const cinemaStats = reactive({
  cinemas: 0,
  accounts: 0,
  /** 是否拿到过数据：没拿到时显示占位符而不是 0 */
  loaded: false
})

export function setCinemaStats(cinemas, accounts) {
  cinemaStats.cinemas = cinemas
  cinemaStats.accounts = accounts
  cinemaStats.loaded = true
}
