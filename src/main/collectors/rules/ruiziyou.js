/**
 * 睿自由（ruiziyou）。
 *
 *   域名      {gz00X}.ruiziyou.com —— 一影城一子域（gz006 / gz007…），主域通配
 *   鉴权      请求头 appid（影城小程序）+ openid（用户标识）+ rid/time/signature（RSA 签名）
 *   账号      只需 openid（+ mobile）
 *
 * 与万花筒同款：openid 即凭证，没有独立 token。签名由请求级 RSA 算出，不用抓。
 */
export default {
  id: 'ruiziyou',
  name: '睿自由',
  enabled: true,
  hosts: ['*.ruiziyou.com'],

  launch: {
    type: 'miniapp',
    name: '睿自由影城'
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
    type: 'sliding',
    idleSeconds: 86400
  }
}
