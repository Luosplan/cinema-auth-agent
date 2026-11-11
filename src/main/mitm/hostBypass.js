/**
 * 全量解密模式的「例外域名表」。
 *
 * 为什么需要全量解密：小程序没有 H5 链接，抓包域名只能提前写进规则。
 * 出票系统有二十多套、小程序影城上百家，靠人肉把每套系统的接口域名配全不现实，
 * 配漏一家的表现就是「代理在跑、参数一个不来」。所以小程序采集走全量解密：
 * TLS 全解开，靠字段名匹配把值捞出来。
 *
 * 为什么必须有例外表：全量解密意味着客户机上所有进程的 HTTPS 都要经过我们的
 * 自签证书。微信自身域名、系统更新、杀毒软件、在线银行这些一旦被解，轻则证书
 * 报错（钉死了证书链的客户端直接握手失败），重则把微信自己搞挂 —— 小程序也就
 * 打不开了，反而抓不到任何业务参数。这些域名一律走原始 TCP 隧道，只看不断。
 *
 * 判断标准很简单：这个域名上不可能出现我们要的会员凭证（mobile / token / userId…）。
 */

/** 精确匹配的域名 */
const EXACT = ['localhost', '127.0.0.1', '0.0.0.0']

/**
 * 后缀匹配（含子域）。写成 com.cn 这类二级后缀也成立 —— matchDomain 用的是
 * 「以 .x 结尾或等于 x」的判定，不会出现 example.com 命中 myexample.com 的情况。
 */
const SUFFIX = [
  // 微信 / 腾讯：解开会让微信自己握手失败，小程序直接打不开
  'weixin.qq.com',
  'wechat.com',
  'wechat.org',
  'wx.qq.com',
  'wxs.qq.com',
  'qq.com',
  'qpic.cn',
  'qlogo.cn',
  'gtimg.cn',
  'tencent.com',
  'tencent-cloud.com',
  'myqcloud.com',
  'servicewechat.com',
  'wxapp.tc.qq.com',
  'dldir1.qq.com',
  'tenpay.com',
  'tenpay.com.cn',

  // Windows / 微软
  'microsoft.com',
  'windows.com',
  'windowsupdate.com',
  'msftconnecttest.com',
  'msftncsi.com',
  'msn.com',
  'live.com',
  'bing.com',
  'office.com',
  'office365.com',
  'sharepoint.com',
  'skype.com',
  'visualstudio.com',
  'nuget.org',

  // Apple / Google：客户机上跑了什么我们不知道，不碰
  'apple.com',
  'icloud.com',
  'mzstatic.com',
  'google.com',
  'gstatic.com',
  'googleapis.com',
  'googleusercontent.com',
  'youtube.com',
  'gvt1.com',

  // 杀毒 / 安全软件的自更新，解开会被它们当成中间人攻击
  '360.cn',
  'qihu.com',
  'huorong.cn',
  'ijinshan.com',
  'kaspersky.com',
  'mcafee.com',
  'norton.com',
  'avast.com',
  'avg.com',
  'eset.com',
  'trendmicro.com',
  'sangfor.com',
  'sangfor.com.cn',

  // 银行 / 支付：证书钉得最死的一类，解开纯属找麻烦
  'icbc.com.cn',
  'ccb.com',
  'abchina.com',
  'boc.cn',
  'bankcomm.com',
  'cmbchina.com',
  'psbc.com',
  'cebbank.com',
  'spdb.com.cn',
  'cib.com.cn',
  'citicbank.com',
  'pingan.com',
  'alipay.com',
  'unionpay.com',
  'unionpaysecure.com',

  // 公共基础设施：解开只会让客户机上的其它软件报证书错
  'cloudflare.com',
  'akamaized.net',
  'akamaihd.net',
  'dnspod.cn',
  'alidns.com',
  'ntp.org',
  'pool.ntp.org',

  // 开发期 Vue DevTools 的服务端，解开只会在日志里刷一堆转发失败
  'vuetelescope.com'
]

function hitSuffix(host, suffix) {
  return host === suffix || host.endsWith('.' + suffix)
}

/**
 * 运行时追加的例外域名。
 *
 * 最要紧的一个是「我们自己的服务端」：全量解密一开，本进程到 zmpt.* 的请求
 * 也会绕进代理，而 Electron 主进程的 fetch 走 Node 的证书库、不认 Windows 根存储，
 * 解包等于把会员端接口全打断 —— 表现就是采集期间列表刷不出来、登录失效。
 */
const runtimeBypass = new Set()

export function addBypassHosts(hosts = []) {
  for (const host of hosts) {
    const h = String(host || '')
      .trim()
      .toLowerCase()
    if (h) runtimeBypass.add(h)
  }
}

/**
 * 这个域名要不要跳过解密。
 * @param {string} host 不带端口的域名
 */
export function isBypassHost(host) {
  const h = String(host || '')
    .trim()
    .toLowerCase()
  if (!h) return true
  if (EXACT.includes(h)) return true
  if (runtimeBypass.has(h)) return true
  return SUFFIX.some((suffix) => hitSuffix(h, suffix))
}

export default { isBypassHost, addBypassHosts }
