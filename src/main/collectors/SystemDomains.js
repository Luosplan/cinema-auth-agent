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
  /**
   * 凤凰系：接口只有 mtop 一个。
   * 页面（h5lark）和静态资源（cdn / g.iyunzhi）不参与取值，解不解密都不影响抓包，
   * 但放开它们会白白多签一堆证书、多解一堆图片 HTML —— 按用户要求只盯接口。
   */
  phoenix: ['mtop.yuekeyun.com'],
  'phoenix-mini': ['mtop.yuekeyun.com'],
  // 佳影的接口挂在 h5web 上（HAR 模板 base 也是它），mtop 一并留着
  'phoenix-jiaying': ['h5web.yuekeyun.com', 'mtop.yuekeyun.com'],
  'phoenix-h5': ['mtop.yuekeyun.com'],

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

  // 随映：接口在 api.shallyim.com 的各租户子域（36010.api.shallyim.com）
  suiying: ['shallyim.com', 'api.shallyim.com'],
  sgycyk: ['shallyim.com', 'api.shallyim.com'],

  /**
   * MiniTicket：**域名不固定**，每家影院自己的域名（xzs11.xcxyyww.cn 只是一家）。
   *
   * 这里登记的族只是「已知的那一批」，认不全 —— 兜底靠路径特征，
   * 见下面的 PATH_HINTS：mini 的接口统一挂在 `<host>/MiniTicket/index.php` 下
   *（服务端 ticket-adapters/mini/Base.js 的 API_ENTRY 就是这个），
   * 所以域名对不上、路径里有 MiniTicket 的同样是这套系统。
   */
  mini: ['xcxyyww.cn'],
  360: ['yingyuan360.cn'],
  yingyuan360: ['yingyuan360.cn'],
  365: ['poke203.com'],
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
  1905: ['1905.com'],
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

/**
 * 系统代号归一：去空格、下划线/点折成连字符。
 * 服务端同一个系统在不同表里写成 `phoenix-h5` / `phoenix_h5` / `Phoenix-H5` 都出现过，
 * 只要有一步没折平，seedHosts 就查不到，最后退化成「全量解密」——
 * 表现就是又慢又混进一堆无关请求。
 */
function normCode(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
}

/**
 * 路径特征：认域名认不准时的第二把尺子。
 *
 * 少数系统的域名根本不固定 —— mini 每家影院一个独立域名，域名表永远补不完。
 * 但它们的接口路径是固定的：mini 统一挂在 `<host>/MiniTicket/index.php` 下
 *（服务端 ticket-adapters/mini/Base.js 的 API_ENTRY，注释原话「各影院只是域名不同」）。
 *
 * 所以「域名对不上、但路径里有 MiniTicket」的请求也算这套系统：
 *   - 抓包窗口里凭它把请求收进线索（并顺手把该域名并进解密范围）；
 *   - 面板合并取值时凭它排除掉同一轮里混进来的其它接口。
 *
 * 关键字写小写，匹配时对路径做小写化，`/MiniTicket/` 与 `/miniticket/` 都认。
 */
const PATH_HINTS = {
  mini: ['miniticket']
}

/** 长 key 优先：phoenix-jiaying 必须先于 phoenix 命中，否则会漏掉它的 h5web */
const SEED_KEYS_BY_LENGTH = Object.keys(SEEDS).sort((a, b) => b.length - a.length)
const HINT_KEYS_BY_LENGTH = Object.keys(PATH_HINTS).sort((a, b) => b.length - a.length)

/** 已知系统的固定域名族；没登记过返回空数组（调用方走「全量解密」兜底） */
export function seedHosts(systemCode) {
  const code = normCode(systemCode)
  if (!code) return ZERO
  if (SEEDS[code]) return SEEDS[code]

  /**
   * 变体兜底：`phoenix-h5-x` / `phoenix-jinri` 这类带尾巴的代号，
   * 归到同前缀的已知系统上。必须按 `前缀 + 分隔符` 对齐，
   * 不能用裸 startsWith —— 否则 `phoenixfoo` 也会被认成 phoenix。
   */
  for (const key of SEED_KEYS_BY_LENGTH) {
    if (code.startsWith(`${key}-`)) return SEEDS[key]
  }
  return ZERO
}

/** 这套系统的路径特征关键字；没有就返回空数组 */
export function pathHintsOf(systemCode) {
  const code = normCode(systemCode)
  if (!code) return ZERO
  if (PATH_HINTS[code]) return PATH_HINTS[code]
  // `mini-v1` / `mini-xxxshdz` 这类变体沿用同一套特征
  for (const key of HINT_KEYS_BY_LENGTH) {
    if (code.startsWith(`${key}-`)) return PATH_HINTS[key]
  }
  return ZERO
}

/** 这条请求的路径是否带该系统特征（域名认不出来时的兜底） */
export function pathMatchesSystem(systemCode, path) {
  const hints = pathHintsOf(systemCode)
  if (!hints.length) return false
  const text = String(path || '').toLowerCase()
  if (!text) return false
  return hints.some((hint) => text.includes(hint))
}

/**
 * 域名族不可靠的系统（各影院独立域名）：抓包时要放开全量解密，靠路径特征收窄。
 * 只有这种系统允许「既有域名族、又全量解密」同时成立。
 */
export function isLooseSystem(systemCode) {
  return pathHintsOf(systemCode).length > 0
}

export default {
  registrableOf,
  inFamily,
  isNoiseHost,
  seedHosts,
  pathHintsOf,
  pathMatchesSystem,
  isLooseSystem
}
