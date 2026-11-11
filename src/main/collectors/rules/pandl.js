/**
 * 潘多拉（pandl）。
 *
 *   域名      pandl.xyz（JavaWeb7 / JavaWeb2 两版前缀，接口能力一致）
 *   登录      GET /JavaWeb7/api/wechat/v1/getAppOpenId?jsCode=... → openid + session_key
 *   鉴权      业务请求靠 body 里的 openId 标识用户 + header cinemaCode 标识影城
 *   账号      只需 openId（+ mobile）
 *
 * 注意登录是 GET 不是 POST —— when.method 不能写死 POST。
 */
export default {
  id: 'pandl',
  name: '潘多拉',
  enabled: true,
  hosts: ['pandl.xyz', '*.pandl.xyz'],

  launch: {
    type: 'miniapp',
    name: '潘多拉影城'
  },

  params: ['mobile', 'openid'],

  capture: {
    fromResponse: [
      {
        when: { pathIncludes: ['getAppOpenId', '/login', '/auth'] },
        // 这套系统的会话凭证是 session_key；openid 是用户身份，一并取回
        tokenPaths: ['data.session_key', 'data.sessionKey', 'session_key', 'sessionKey'],
        accountPaths: ['data.openid', 'openid', 'data.mobile'],
        expirePaths: ['data.expiresIn', 'data.expires_in'],
        extraPaths: {
          openid: ['data.openid', 'openid', 'data.openId']
        }
      }
    ],
    fromRequestHeader: []
  },

  expiry: {
    // 微信 session_key 随微信会话滑动，按滑动续期估算
    type: 'sliding',
    idleSeconds: 7200
  }
}
