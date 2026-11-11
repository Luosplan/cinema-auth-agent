/**
 * 星云 1905 系统。
 *
 *   域名      dghx.xingyun.1905.com（xingyun.1905.com 主域通配兜底，一影城一子域）
 *   接口      /api/wechat/**，除 token 外必带 ccode（影院编码）+ ver（版本号）
 *   登录      POST /api/wechat/user/login（wx.login code + cinema_code）→ JWT
 *   鉴权      请求头 token: <JWT>（注意：不是 Authorization，头名就叫 token）
 *   续期      无刷新接口，JWT 过期重新抓包
 */
export default {
  id: '1905',
  name: '星云1905',
  enabled: true,
  hosts: ['dghx.xingyun.1905.com', '*.xingyun.1905.com'],

  launch: {
    type: 'miniapp',
    name: '1905影城',
    // 样本影城（华夏影院家汇店）的 appid；其他影城以后台 accessAppId 为准
    appid: 'wx2c9c93893f595cbc'
  },

  params: ['mobile', 'token'],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['/user/login', '/login', '/auth'] },
        tokenPaths: ['data.token', 'data.accessToken', 'token', 'data.access_token'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.userId'],
        expirePaths: ['data.expiresIn', 'data.expireTime', 'data.exp']
      }
    ],
    fromRequestHeader: ['token', 'authorization']
  },

  expiry: {
    type: 'absolute',
    defaultSeconds: 86400
  }
}
