/**
 * 365 系统。
 *
 *   域名      imovie365api.poke203.com 等（poke203.com 主域通配兜底）
 *   鉴权      请求头 Authorization: Bearer <token>，外加 platform: wx + cinemacode 标识影城
 *   续期      无独立刷新接口（refreshToken:false），过期重新抓包
 *
 * 一家影城一个小程序，appid 在影城自己的 accessAppId 里，规则不写死。
 */
export default {
  id: '365',
  name: '365系统',
  enabled: true,
  hosts: ['imovie365api.poke203.com', '*.poke203.com'],

  launch: {
    type: 'miniapp',
    name: '365影城'
  },

  params: ['mobile', 'authorization'],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['/login', '/auth', '/wxLogin', '/loginma'] },
        tokenPaths: ['data.token', 'data.accessToken', 'data.access_token', 'token', 'accessToken'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.userId', 'data.phone'],
        expirePaths: ['data.expiresIn', 'data.expireTime', 'data.expires_in']
      }
    ],
    fromRequestHeader: ['authorization', 'token']
  },

  expiry: {
    type: 'absolute',
    defaultSeconds: 86400
  }
}
