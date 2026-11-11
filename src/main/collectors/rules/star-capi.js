/**
 * 辰星新锐（star-capi）—— 辰星 CAPI 网关代。
 *
 * 与 star-open（奥斯卡/开放平台）同属辰星，但走的是 capi 域老网关：
 *   域名      capi.oristarcloud.com（小程序登录会先走 open 域 /api/auth/token）
 *   登录      POST /selfSupport/front/user/login3rd（openId 第三方登录）
 *             → result.token（H5 端鉴权 JWT）/ result.memberID
 *   鉴权      H5：Authorization: Bearer <token> + body.k（业务 token，双凭证缺一不可）
 *             小程序：body.k + star-tenant 头
 *   k         业务 token，公共请求体里有 k="123" 占位值，必须按路径精确取，与奥斯卡同坑
 *
 * 端是 hybrid：DJKPBYY 等是 H5（各家影城一个 h5 子域，入口走影城自己的 accessUrl），
 * BSYC/WHFSYC 等是小程序（一店一个 appid，入口走影城自己的 accessAppId）。
 */
export default {
  id: 'star-capi',
  name: '辰星新锐',
  enabled: true,
  hosts: ['capi.oristarcloud.com', 'open.oristarcloud.com', '*.oristarcloud.com'],

  launch: {
    type: 'h5',
    name: '辰星新锐'
  },

  params: [
    { key: 'mobile', required: true },
    // 与奥斯卡同款坑：公共请求体里 k="123" 是占位值，只认真业务 token
    { key: 'k', required: true, paths: ['data.k', 'result.k', 'data.baseTypeRes'], deny: ['123'] },
    { key: 'openid', required: false, reqPaths: ['openId', 'openid', 'thirdId'] },
    { key: 'authorization', required: true, header: 'authorization' }
  ],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['/login3rd', '/register3rd', '/auth/token'] },
        tokenPaths: ['result.token', 'data.token', 'data.accessToken', 'token'],
        accountPaths: ['result.memberID', 'data.memberId', 'data.mobile', 'result.mobile'],
        expirePaths: ['data.expiresIn', 'data.expireTime', 'result.expiresIn']
      }
    ],
    fromRequestHeader: ['authorization']
  },

  expiry: {
    // Base 有真实 refreshToken（重新 login3rd 回写），按滑动续期估算
    type: 'sliding',
    idleSeconds: 7200
  }
}
