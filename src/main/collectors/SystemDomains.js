/**
 * 各出票系统的「固定域名族」。
 *
 * 为什么要有这张表：
 *   MITM 解密不是白给的 —— 每条 HTTPS 都要现签一张叶证书、解密、再看一遍响应体。
 *   一旦放开「全量解密」，浏览器里所有后台流量（阿里 CDN、埋点、Google 字体、淘宝 h5api）
 *   都会跟着被抓进来：既拖慢页面，又会把无关字段（taobao 的同名 phone、cookie 里的同名 key）
 *   混进参数取值里，最后表现成「抓到的手机号不是这台影城的」。
 *
 *   这几家系统的接口域名本来就是固定的（凤凰云智永远在 yuekeyun.com 上），
 *   所以点哪家影城就只解密它那一族，其余一律隧道直通 —— 不碰、不抓、不记。
 *
 * 值用「可注册域名」级别（gyyse.com 而不是 app.app.gyyse.com），
 * 这样一个条目就能覆盖 h5lark / mtop / cdn / h5lark-be 这整族子域。
 * 数据来源：服务端 ticket-adapters 与 cinemagroups 种子里的 baseUrl。
 */

const ZERO = []

/** systemCode → 域名族。key 同时收系统表 code 和影城表里的老叫法 */
const SEEDS = {
  // 凤凰系：H5 页面在 h5lark，接口在 mtop，静态在 cdn，前端包在 g.iyunzhi.com
  phoenix: ['yuekeyun.com', 'iyunzhi.com'],
  'phoenix-mini': ['yuekeyun.com', 'iyunzhi.com'],
  'phoenix-jiaying': ['yuekeyun.com', 'iyunzhi.com'],
  'phoenix-h5': ['yuekeyun.com', 'iyunzhi.com'],

  // 辰星系：每家影城一个子域（h5jnjhyc.oristarcloud.com），族根一致
  'star-open': ['oristarcloud.com'],
  'star-capi': ['oristarcloud.com'],
  oristar: ['oristarcloud.com'],
  'cx-2': ['oristarcloud.com'],
  'cx-v1': ['oristarcloud.com'],
  'cx-v3': ['oristarcloud.com'],
  'cx-v104': ['oristarcloud.com'],
  'cx-middleground': ['oristarcloud.com'],
  blwh: ['oristarcloud.com'],

  suiying: ['shallyim.com'],
  sgycyk: ['shallyim.com'],
  '360': ['yingyuan360.cn'],
  yingyuan360: ['yingyuan360.cn'],
  '365': ['poke203.com'],
  imovie365: ['poke203.com'],
  'imovie365-sdgj': ['poke203.com'],
  'imovie-h5': ['poke203.com'],
  pandl: ['pandl.xyz', 'pandll.cn'],
  pandora: ['pandl.xyz', 'pandll.cn'],
  wonder: ['legendpicture.com', 'ydxinshili.com'],
  wanhuatong: ['legendpicture.com', 'ydxinshili.com'],
  ruiziyou: ['ruiziyou.com'],
  tonul: ['tonul.cn'],
  paimeng: ['tonul.cn'],
  jintaotao: ['jintaotaodianying.com'],
  '1905': ['1905.com'],
  movie1905: ['1905.com'],
  whale: ['jingyumovie.cn'],
  jingyu: ['jingyumovie.cn'],
  walland: ['ai-datas.com'],
  douyou: ['douyou100.com'],
  jmtnt: ['jmtnt.com'],
  hypiao: ['hypiao.com'],
  huiyingpiao: ['hypiao.com'],
  // 重明鸟 / 光影同厂：接口都在 cmn.gyyse.com 下，重明鸟另有 yxpwt.com
  lumenbird: ['cmn.gyyse.com', 'yxpwt.com'],
  chongmingniao: ['cmn.gyyse.com', 'yxpwt.com'],
  'chongmingniao-v3': ['cmn.gyyse.com', 'yxpwt.com'],
  gyyse: ['gyyse.com'],
  // 光影的其它门面：guoyu 是同一套接口，只是运营口径叫光影系统
  guoyu: ['gyyse.com'],
  'xiangsu-zhongying': ['gyyse.com'],
  lumiai: ['lumiai.com'],
  lumiere: ['lumiai.com'],
  bona: ['dxds-china.com'],
  'bona-dxds': ['dxds-china.com'],
  laiyipiao: ['laiyipiao.com'],
  liegou: ['liegoumovie.com', 'zjlrmovie.cn'],
  yingban: ['iyingban.cn'],
  iyingban: ['iyingban.cn']
}

/**
 * 噪声域名：埋点 / CDN / 前端框架 / 地图，永远不是出票接口。
 * 它们即使在「全量解密」兜底模式下被抓到，也不参与取值、不进线索 ——
 * 否则线索里会堆满 alicdn、mmstat，真正要看的那几个反而被淹掉。
 *
 * 只收「确定不可能带凭证」的：宁可少排除，也不能把真接口排除掉。
 */
const NOISE = [
  'mmstat.com',
  'alicdn.com',
  'aliyun.com',
  'aliyuncs.com',
  'taobao.com',
  'tmall.com',
  '1688.com',
  'googleapis.com',
  'gstatic.com',
  'google.com',
  'g.cn',
  'baidu.com',
  'bdstatic.com',
  'gtimg.com',
  'myqcloud.com',
  'servicewechat.com',
  'amap.com',
  'cnzz.com',
  'umeng.com',
  'sentry.io',
  'bugly.qq.com'
]

/** 常见两段式公共后缀，别把 co.jp 当成域名主干 */
const MULTI_SUFFIX = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.hk', 'com.tw', 'co.jp'])

function bare(host) {
  return String(host || '')
    .toLowerCase()
    .replace(/:\d+$/, '')
    .trim()
}

/**
 * 取「可注册域名」：h5lark.yuekeyun.com → yuekeyun.com。
 *
 * 不引 psl 包：这里只用来兜底收窄范围，误判成 com.cn 级别最多是多放宽一层，
 * 不会造成「本该抓的抓不到」。
 */
export function registrableOf(host) {
  const h = bare(host)
  if (!h) return ''
  const parts = h.split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  const last2 = parts.slice(-2).join('.')
  if (MULTI_SUFFIX.has(last2)) return parts.slice(-3).join('.')
  return last2
}

/** host 是否落在某个域名族里（含族本身与它的所有子域） */
export function inFamily(host, families) {
  const h = bare(host)
  if (!h) return false
  for (const family of families || []) {
    const f = bare(family)
    if (!f) continue
    if (h === f || h.endsWith(`.${f}`)) return true
  }
  return false
}

/** 是否为噪声域名 */
export function isNoiseHost(host) {
  const h = bare(host)
  if (!h) return false
  for (const noise of NOISE) {
    if (h === noise || h.endsWith(`.${noise}`)) return true
  }
  return false
}

/** 已知系统的固定域名族；没登记过返回空数组（调用方走「全量解密」兜底） */
export function seedHosts(systemCode) {
  const code = String(systemCode || '')
    .trim()
    .toLowerCase()
  if (!code) return ZERO
  return SEEDS[code] || ZERO
}

export default { registrableOf, inFamily, isNoiseHost, seedHosts }
