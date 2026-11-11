/**
 * 奥斯卡 / 辰星开放平台（star-open）。
 *
 * 参数来自服务端适配器 `ticket-adapters/star-open`：
 *   域名      https://open.oristarcloud.com
 *   ① 取鉴权   POST /api/auth/token             （不需要 Authorization）
 *              → data.token                    → 存进 Authorization 头
 *   ② 换业务 k POST /api/middleground/member/token/add  （带 Authorization）
 *              → data.baseTypeRes              → 就是后台要的 k
 *   ③ 心跳     POST /api/middleground/member/token/heart
 *   openid     来自微信登录请求体（login3rd 的 openId）
 *   手机号     来自会员信息接口的 mobile / phone
 *
 * 后台「影城参数」要的正是这四项：手机号 / k / openid / Authorization。
 * 它们分散在请求头、请求体、响应体三处，且不是同一个请求，
 * 所以参数包是「增量补齐」的 —— 操作员在页面上正常操作一遍，四项就会陆续到齐。
 *
 * ⚠ accessType 是 miniapp，后台 accessUrl 为空，没有 H5 入口，
 *   只能通过微信打开小程序 `wx09d3bba3fe063a04`。
 */
export default {
  id: 'star-open',
  name: '奥斯卡',
  enabled: true,
  hosts: ['open.oristarcloud.com'],

  // 「获取参数」时用它决定怎么把页面打开（h5 自动开；miniapp 唤起微信）
  launch: {
    type: 'miniapp',
    name: '奥斯卡',
    appid: 'wx09d3bba3fe063a04'
  },

  params: [
    { key: 'mobile', required: true },
    // k 只认业务 token 接口的 baseTypeRes，避免把公共请求体里的 k="123" 当成真值
    { key: 'k', required: true, paths: ['data.baseTypeRes'], deny: ['123'] },
    // openid 是入参，只可能出现在请求体里
    { key: 'openid', required: true, reqPaths: ['openId', 'openid', 'open_id'] },
    { key: 'authorization', required: true, header: 'authorization' }
  ],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['/api/auth/token'] },
        tokenPaths: ['data.token'],
        accountPaths: [],
        expirePaths: []
      }
    ],
    // 业务请求都会带 Bearer，作为主凭证的兜底来源
    fromRequestHeader: ['authorization']
  },

  expiry: {
    // 有 /member/token/heart 心跳，按滑动续期估算
    type: 'sliding',
    idleSeconds: 7200
  }
}
