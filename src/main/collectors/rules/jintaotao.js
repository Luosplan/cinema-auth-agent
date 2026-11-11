/**
 * 金桃淘电影（jintaotao）。
 *
 *   域名      ww.jintaotaodianying.com，接口前缀 /prod-api
 *   登录      POST /prod-api/auth/xcx/wxloginOne（wx.login code）
 *             → data.access_token（JWT，expires_in ≈ 7 天）
 *   鉴权      请求头 Authorization: Bearer <access_token>
 */
export default {
  id: 'jintaotao',
  name: '金桃淘电影',
  enabled: true,
  hosts: ['ww.jintaotaodianying.com', '*.jintaotaodianying.com'],

  launch: {
    type: 'miniapp',
    name: '金桃淘电影'
  },

  params: ['mobile', 'authorization'],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['wxloginOne', '/login', '/auth'] },
        tokenPaths: ['data.access_token', 'data.accessToken', 'data.token', 'access_token'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.userId'],
        expirePaths: ['data.expires_in', 'data.expiresIn', 'expires_in']
      }
    ],
    fromRequestHeader: ['authorization']
  },

  expiry: {
    // access_token JWT 有效期约 7 天
    type: 'absolute',
    defaultSeconds: 604800
  }
}
