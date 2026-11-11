/**
 * 来一票（laiyipiao）。
 *
 *   域名      weixin.laiyipiao.com，两套前缀 /mpwxmini/（辅助）+ /mpmultiport/（购票主链路）
 *   小程序    来一票 wxa8c3f2bec1e65670（统一小程序，连锁门店走 chain.stores）
 *   鉴权      服务端只按 body 里的 user_id 定位用户
 *             （实测 session_id 写错也放行，user_id 换掉立刻 301 —— user_id 才是真凭证）
 *   账号      user_id / session_id / openid / mobile
 *   续期      登录态由 wx.login + 手机号授权产生，不可刷新，失效重新抓包
 *
 * user_id / session_id 是 snake_case，规则里保留原样声明；
 * 规范化（去下划线）由 ParamResolver 统一处理。
 */
export default {
  id: 'laiyipiao',
  name: '来一票',
  enabled: true,
  hosts: ['weixin.laiyipiao.com', '*.laiyipiao.com'],

  launch: {
    type: 'miniapp',
    name: '来一票',
    appid: 'wxa8c3f2bec1e65670'
  },

  params: [
    { key: 'mobile', required: false },
    { key: 'user_id', label: '用户 ID', required: true },
    { key: 'session_id', label: '会话 ID', required: false }
  ],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['login', 'Login', 'auth', 'member'] },
        // user_id 是这套系统的真凭证，主凭证槽位放它
        tokenPaths: ['data.user_id', 'data.userId', 'user_id', 'userId'],
        accountPaths: ['data.mobile', 'data.nickName', 'mobile'],
        expirePaths: [],
        extraPaths: {
          session_id: ['data.session_id', 'data.sessionId', 'session_id'],
          openid: ['data.openid', 'openid', 'data.openId']
        }
      }
    ],
    fromRequestHeader: []
  },

  expiry: {
    type: 'absolute',
    defaultSeconds: 86400
  }
}
