/**
 * 凤凰佳影（phoenix-jiaying）—— 凤凰系的佳影分支，纯 H5。
 *
 *   域名      h5web.yuekeyun.com
 *   会话      Cookie 里的 sid / tid（{appId}L、TKT_Appid 这组佳影自己的 cookie 名）
 *   续期      会话超时（SESSION_TIMEOUT）后用 tid 调 getSidByTid 换新 sid —— 滑动续期
 *
 * sid / tid 基本只出现在 cookie 和页面存储里，登录响应 JSON 里未必有，
 * 所以参数弹窗那边靠 cookie / localStorage 抓取兜底，这里主要提供域名和续期特性。
 */
export default {
  id: 'phoenix-jiaying',
  name: '凤凰佳影',
  enabled: true,
  hosts: ['h5web.yuekeyun.com', '*.yuekeyun.com'],

  launch: {
    type: 'h5',
    name: '凤凰佳影'
  },

  params: ['mobile', 'larksid', 'tid'],

  capture: {
    fromResponse: [
      {
        when: { pathIncludes: ['login', 'getSidByTid', 'getsidbytid', 'auth'] },
        tokenPaths: ['data.sid', 'data.token', 'data.data.sid'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.userId'],
        expirePaths: ['data.expiresIn', 'data.expireTime']
      }
    ],
    fromRequestHeader: []
  },

  expiry: {
    // tid 换 sid 是真实刷新，按滑动续期估算
    type: 'sliding',
    idleSeconds: 7200
  }
}
