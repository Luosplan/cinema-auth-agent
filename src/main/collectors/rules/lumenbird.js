/**
 * 重明鸟（lumenbird）—— cmn 云平台两代接口并存。
 *
 *   cmn-v1（老版）：mini-api / tc-api.cmn.gyyse.com，api=flower.* / ticketcenter.wap.*
 *                  双 token：请求头 mbrToken（会员）+ wapToken（wap）
 *                  登录 ticketcenter.wap.flower.auth.login → wapInfo.data.token
 *   cmn-v2（新版）：client.cmn.yxpwt.com/client-api，RESTful
 *                  单 token：请求头 applet-token
 *                  登录两段式 POST /user/auth/maLogin → /user/auth/mpLogin 拿正式 token
 *
 * 两代都不支持服务端模拟登录（v2 要 wx.login 的 code），token 由抓包取得。
 * 一家影城一个小程序，appid 在影城自己的 accessAppId 里，规则不写死。
 */
export default {
  id: 'lumenbird',
  name: '重明鸟',
  enabled: true,
  hosts: [
    'mini-api.cmn.gyyse.com',
    'tc-api.cmn.gyyse.com',
    '*.cmn.gyyse.com',
    'client.cmn.yxpwt.com',
    '*.yxpwt.com'
  ],

  launch: {
    type: 'miniapp',
    name: '重明鸟'
  },

  params: [
    { key: 'mobile', required: true },
    // v1 是 mbrToken/wapToken 双 token，v2 是 applet-token 单 token，按名都能落进 token
    { key: 'token', required: true },
    { key: 'waptoken', label: 'wapToken', required: false }
  ],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['auth.login', 'maLogin', 'mpLogin', '/login'] },
        tokenPaths: [
          'wapInfo.data.token',
          'data.token',
          'data.appletToken',
          'data.accessToken',
          'token'
        ],
        accountPaths: ['data.mobile', 'data.nickName', 'data.userId', 'wapInfo.data.mobile'],
        expirePaths: ['data.expiresIn', 'data.expireTime'],
        extraPaths: {
          refreshToken: ['data.refreshToken']
        }
      }
    ],
    // v1 的 mbrToken / wapToken、v2 的 applet-token 都在请求头里，兜底被动采集
    fromRequestHeader: ['applet-token', 'mbrtoken', 'waptoken']
  },

  expiry: {
    // 两代都没有刷新接口（refreshToken:false），过期只能重抓；按 1 天保守估算
    type: 'absolute',
    defaultSeconds: 86400
  }
}
