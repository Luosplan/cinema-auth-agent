/**
 * 博纳（bona）。
 *
 *   域名      www.dxds-china.com，接口前缀 /bona/api/（渠道服务商「大象点数」）
 *   小程序    博纳影票 wx74ce5d349688e233（自营统一小程序，连锁门店走 chain.stores）
 *   登录      POST /bona/api/index/walogin（wx.login 一次性 code 换发）
 *   鉴权      请求头 token: <登录态>（头名就叫 token）
 *   续期      不可模拟登录，token 失效（code=401）后重新抓包
 */
export default {
  id: 'bona',
  name: '博纳',
  enabled: true,
  hosts: ['www.dxds-china.com', '*.dxds-china.com'],

  launch: {
    type: 'miniapp',
    name: '博纳影票',
    appid: 'wx74ce5d349688e233'
  },

  params: ['mobile', 'token'],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['walogin', '/login', '/auth'] },
        tokenPaths: ['data.token', 'data.accessToken', 'token', 'data.access_token'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.userId'],
        expirePaths: ['data.expiresIn', 'data.expireTime']
      }
    ],
    fromRequestHeader: ['token', 'authorization']
  },

  expiry: {
    type: 'absolute',
    defaultSeconds: 86400
  }
}
