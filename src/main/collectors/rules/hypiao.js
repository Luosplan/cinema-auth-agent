/**
 * 惠影票（hypiao）。
 *
 *   域名      prod.hypiao.com，接口前缀 /prod-api
 *   小程序    惠影票 wx4bd70b8fe7079311（统一小程序，cinemaId 区分影院）
 *   登录      POST /prod-api/auth/xcx/wxloginOne { codeLogin, appId }（匿名登录）→ token + openId
 *   鉴权      请求头 Authorization: Bearer <token>
 *   账号      只需 token
 */
export default {
  id: 'hypiao',
  name: '惠影票',
  enabled: true,
  hosts: ['prod.hypiao.com', '*.hypiao.com'],

  launch: {
    type: 'miniapp',
    name: '惠影票',
    appid: 'wx4bd70b8fe7079311'
  },

  params: ['mobile', 'authorization'],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['wxloginOne', '/login', '/auth'] },
        tokenPaths: ['data.token', 'data.accessToken', 'data.access_token', 'token'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.openId', 'data.userId'],
        expirePaths: ['data.expiresIn', 'data.expireTime', 'data.expires_in']
      }
    ],
    fromRequestHeader: ['authorization']
  },

  expiry: {
    type: 'absolute',
    defaultSeconds: 86400
  }
}
