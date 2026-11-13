/**
 * 「这次就是抓不到」的提前收尾判据。
 *
 * 抓包窗口原本只按时间收尾（45 秒），但有一半的点击根本等不到东西：
 * 这套程序这次没流量、或者流量全落在别的域名上、或者字段名对不上。
 * 干等满一轮的体感就是「一直在获取，最后什么都没有」。
 *
 * 判据不能用「等了多久」单独判断 —— 用户点完按钮再切到浏览器刷新，
 * 中间隔十几秒很正常。所以看的是**流量有没有进来、进来的是不是目标**：
 *
 *   no-traffic : 本轮一条连接都没有 → 页面没刷新，或流量没走本机代理
 *   no-match   : 解密了几十条流量，一条目标请求都没命中 → 域名 / 路径不对
 *   stuck      : 目标请求抓到了几条，但字段一个都取不出来 → 字段名对不上
 *
 * 三种情况再等下去都不会自己变好。已经抓到值的（gotCount > 0）一律不提前收尾，
 * 交给窗口自己的「凑齐就停 / 只差手机号多等 2.5 秒」逻辑。
 */

export const IDLE_NO_TRAFFIC_MS = 25000
export const IDLE_NO_MATCH_MS = 15000
export const IDLE_STUCK_MS = 18000

/** 「解密了几十条流量」的门槛：低于这个数说明还没开始刷页面，不能判 no-match */
const NO_MATCH_MIN_INTERCEPTED = 30

/** 「目标请求确实抓到了几条」的门槛：1 条可能是预检 / 探活，5 条才说明接口通了 */
const STUCK_MIN_ACCEPTED = 5

/**
 * @param {object} input
 * @param {number} input.waitedMs      本轮已等待毫秒数
 * @param {number} input.intercepted   本轮新增的解密连接数（含静态资源）
 * @param {number} input.traffic       本轮新增的总连接数
 * @param {number} input.acceptedCount 命中「目标系统」的记录条数
 * @param {number} input.gotCount      已经取到的字段个数
 * @param {boolean} input.loose        本轮是否在「全量解密」模式（域名不固定的系统）
 * @returns {'' | 'no-traffic' | 'no-match' | 'stuck'} 空串表示继续等
 */
export function decideEarlyExit({
  waitedMs,
  intercepted,
  traffic,
  acceptedCount,
  gotCount,
  loose
} = {}) {
  const got = Number(gotCount) || 0
  if (got > 0) return ''

  const waited = Number(waitedMs) || 0
  const decrypted = Number(intercepted) || 0
  const total = Number(traffic) || 0
  const accepted = Number(acceptedCount) || 0

  if (accepted === 0) {
    /**
     * 全量解密模式下**不做 no-match 判断**：那时解密条数里大部分是浏览器自己的后台流量
     *（mini 这种系统一放开就是几十条），拿它当「目标系统的流量来了」会误杀 ——
     * 用户还在找小程序入口，程序已经判定「没有目标请求」退出了。
     */
    if (!loose && decrypted >= NO_MATCH_MIN_INTERCEPTED && waited >= IDLE_NO_MATCH_MS) {
      return 'no-match'
    }
    // 连连接都没有：等到 no-traffic 的窗口才下结论，给用户留足切窗口的时间
    if (total === 0 && waited >= IDLE_NO_TRAFFIC_MS) return 'no-traffic'
    return ''
  }

  // 目标请求到了几条，却一个字段都取不出来
  if (accepted >= STUCK_MIN_ACCEPTED && waited >= IDLE_STUCK_MS) return 'stuck'
  return ''
}

export default { decideEarlyExit, IDLE_NO_TRAFFIC_MS, IDLE_NO_MATCH_MS, IDLE_STUCK_MS }
