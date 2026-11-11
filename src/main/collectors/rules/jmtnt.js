/**
 * 吉木同（jmtnt，万象影驿）。
 *
 *   域名      apis.jmtnt.com:18811（备 v2.jmtnt.com:18811）
 *             ⚠ 非标准端口不影响命中：代理按 CONNECT 的 host 匹配，hosts 只写域名
 *   登录      wx.login code → applogin 换 token / userId
 *   鉴权      请求头 Authorization: Bearer <token> + mchId（商户/影院 ID）+ action
 *   续期      无刷新接口，token 过期重新抓包
 */
export default {
  id: 'jmtnt',
  name: '吉木同',
  enabled: true,
  hosts: ['apis.jmtnt.com', 'v2.jmtnt.com', '*.jmtnt.com'],

  launch: {
    type: 'miniapp',
    name: '万象影驿'
  },

  params: ['mobile', 'authorization', 'memberid'],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['applogin', '/login', '/auth'] },
        tokenPaths: ['data.token', 'data.accessToken', 'token', 'data.access_token'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.userId'],
        expirePaths: ['data.expiresIn', 'data.expireTime'],
        extraPaths: {
          userId: ['data.userId', 'userId', 'data.user_id']
        }
      }
    ],
    fromRequestHeader: ['authorization']
  },

  expiry: {
    type: 'absolute',
    defaultSeconds: 86400
  }
}
