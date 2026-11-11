/**
 * 鬣狗（liegou）。
 *
 *   域名      业务 ticket.liegoumovie.com（/ticket_api/v1）+ 认证 auth.liegoumovie.com
 *   小程序    每个影院一个独立 appid（如三河中影南方影城店 wx96e29e8a553d08ac），
 *             不写死，以影城后台 accessAppId 为准
 *   登录      /api/tinyapp/autologin
 *   鉴权      请求头 Authorization: Bearer <token>（JWT 由一次性 wx.login code 换发）
 *   续期      无刷新接口；失效返回 401 或 45002（openid 已失效）
 */
export default {
  id: 'liegou',
  name: '鬣狗',
  enabled: true,
  hosts: ['ticket.liegoumovie.com', 'auth.liegoumovie.com', '*.liegoumovie.com'],

  launch: {
    type: 'miniapp',
    name: '鬣狗票务'
  },

  params: ['mobile', 'authorization'],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['autologin', '/login', '/auth'] },
        tokenPaths: ['data.token', 'data.accessToken', 'data.access_token', 'token'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.userId', 'data.user.id'],
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
