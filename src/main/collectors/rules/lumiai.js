/**
 * 卢米埃（lumiai）。
 *
 *   域名      app.lumiai.com，接口前缀 /mp/
 *   小程序    卢米埃 wx69b6a61ab5a2566f（自营院线统一小程序，一家影院一个 cinema_id）
 *   登录      wx.login + 手机号授权 → /mp/iuser/wx_login
 *   鉴权      Cookie: ig_session=<token>（请求头另有 version: 1.00）
 *   账号      token（ig_session）+ mobile
 *
 * 凭证在 cookie 里不在 JSON 里：参数弹窗靠 cookie 抓取兜底，
 * fromResponse 只覆盖登录响应里可能回显的字段。
 */
export default {
  id: 'lumiai',
  name: '卢米埃',
  enabled: true,
  hosts: ['app.lumiai.com', '*.lumiai.com'],

  launch: {
    type: 'miniapp',
    name: '卢米埃',
    appid: 'wx69b6a61ab5a2566f'
  },

  params: ['mobile', 'token'],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['wx_login', '/login', '/auth'] },
        tokenPaths: ['data.token', 'data.ig_session', 'token', 'data.sessionId'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.userId'],
        expirePaths: ['data.expiresIn', 'data.expireTime']
      }
    ],
    fromRequestHeader: ['token', 'authorization']
  },

  expiry: {
    // 登录态依赖 wx 会话，服务端不可刷新；按 1 天保守估算
    type: 'absolute',
    defaultSeconds: 86400
  }
}
