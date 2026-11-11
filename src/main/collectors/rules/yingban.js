/**
 * 影伴（yingban）。
 *
 *   域名      api.iyingban.cn（前缀 /api）
 *   小程序    每个影院一个独立 appid（如张家港万达影伴广场店），
 *             不写死，以影城后台 accessAppId 为准
 *   登录      POST /api/auth/login { appid, code }（一次性 wx.login code 换发 JWT）
 *   鉴权      请求头 authorization: Bearer <token>（小写头名）
 *   续期      无刷新接口；失效返回 401 或 45002
 */
export default {
  id: 'yingban',
  name: '影伴',
  enabled: true,
  hosts: ['api.iyingban.cn', '*.iyingban.cn'],

  launch: {
    type: 'miniapp',
    name: '影伴'
  },

  params: ['mobile', 'authorization'],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['/auth/login', '/login', '/auth'] },
        tokenPaths: ['data.token', 'data.accessToken', 'data.access_token', 'token'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.userId'],
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
