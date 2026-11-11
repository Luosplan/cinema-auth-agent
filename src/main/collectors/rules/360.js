/**
 * 360 系统（影源360）。
 *
 *   域名      {tenantKey}.api.yingyuan360.cn —— 一租户一域名，只能写主域通配
 *   鉴权      请求头 Authorization: Bearer <token> + Tenant-Key + Cinema-Id
 *   凭证      token 是 JWT，实测有效期约 30 天
 *   续期      无刷新接口；失效时平台不回 401，而是 members/show 返回 is_login=false，
 *             所以过期时间只能按 JWT 寿命估算，别等错误信号
 */
export default {
  id: '360',
  name: '360系统',
  enabled: true,
  hosts: ['*.yingyuan360.cn'],

  launch: {
    type: 'miniapp',
    name: '360影城'
  },

  params: ['mobile', 'authorization'],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['/login', '/auth', '/wxLogin'] },
        tokenPaths: ['data.token', 'data.accessToken', 'data.access_token', 'token'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.userId', 'data.member_info.mobile'],
        expirePaths: ['data.expiresIn', 'data.expireTime', 'data.exp']
      }
    ],
    fromRequestHeader: ['authorization']
  },

  expiry: {
    // JWT 实测 ≈ 签发后 30 天
    type: 'absolute',
    defaultSeconds: 2592000
  }
}
