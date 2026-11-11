/**
 * 兜有电影（douyou）。
 *
 *   域名      xcx.douyou100.com
 *   登录      POST /api/v2/member/loginNew.json
 *             → user.token / user.userId / user.mobile
 *   鉴权      请求体公共参数 token + account（登录会话凭证）+ channel（影院渠道号）
 *   小程序    一家影院一个小程序 appid（兜有电影/初云电影），appid 在影城 accessAppId 里
 *
 * token 在请求体里不在请求头，fromRequestHeader 兜不到，靠登录响应精确路径。
 */
export default {
  id: 'douyou',
  name: '兜有电影',
  enabled: true,
  hosts: ['xcx.douyou100.com'],

  launch: {
    type: 'miniapp',
    name: '兜有电影'
  },

  params: ['mobile', 'token', 'memberid'],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['loginNew', '/login', '/auth'] },
        tokenPaths: ['data.user.token', 'user.token', 'data.token', 'token'],
        accountPaths: ['data.user.mobile', 'user.mobile', 'data.mobile', 'mobile'],
        expirePaths: ['data.expiresIn', 'data.expireTime'],
        extraPaths: {
          userId: ['data.user.userId', 'user.userId', 'data.userId']
        }
      }
    ],
    fromRequestHeader: ['authorization', 'token']
  },

  expiry: {
    type: 'sliding',
    idleSeconds: 7200
  }
}
