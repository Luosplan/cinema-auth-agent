/**
 * 万花筒（wonder）。
 *
 *   域名      wonder.legendpicture.com
 *   小程序    wx9ff54c95cf7b9fe6
 *   鉴权      用户身份就是 body 里的 openid（+ 每请求 MD5 签名，签名不用抓）
 *   账号      只需 openid（+ 可选 mobile）
 *
 * 这套系统没有「登录换 token」的概念：openid 就是凭证本身。
 * 抓到 openid 即算抓齐，主凭证槽位也放它。
 */
export default {
  id: 'wonder',
  name: '万花筒',
  enabled: true,
  hosts: ['wonder.legendpicture.com'],

  launch: {
    type: 'miniapp',
    name: '万花筒影城',
    appid: 'wx9ff54c95cf7b9fe6'
  },

  params: ['mobile', 'openid'],

  capture: {
    fromResponse: [
      {
        when: { pathIncludes: ['login', 'Login', 'auth', 'openid'] },
        tokenPaths: ['data.openid', 'openid', 'data.openId', 'data.token', 'token'],
        accountPaths: ['data.mobile', 'data.nickName', 'mobile'],
        expirePaths: []
      }
    ],
    fromRequestHeader: []
  },

  expiry: {
    // openid 本身不过期，签名随时算；给个长窗口仅作展示
    type: 'sliding',
    idleSeconds: 86400
  }
}
