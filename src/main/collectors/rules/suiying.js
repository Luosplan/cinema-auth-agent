/**
 * 随映系统（suiying）—— 纯 H5。
 *
 *   域名      36010.api.shallyim.com 等（shallyim.com 主域通配兜底）
 *   鉴权      请求头 X-Access-Token（JWT）+ X-Sign（MD5 签名，随请求计算，不用抓）
 *   账号      openId / memberId / token
 *   续期      无刷新接口，过期重新抓包
 */
export default {
  id: 'suiying',
  name: '随映系统',
  enabled: true,
  hosts: ['36010.api.shallyim.com', '*.shallyim.com'],

  launch: {
    type: 'h5',
    name: '随映'
  },

  params: ['mobile', 'token', 'openid', 'memberid'],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['/login', '/auth', '/wxLogin'] },
        tokenPaths: ['data.token', 'data.accessToken', 'data.access_token', 'token'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.memberId', 'data.userId'],
        expirePaths: ['data.expiresIn', 'data.expireTime'],
        extraPaths: {
          openid: ['data.openId', 'data.openid', 'openId'],
          memberId: ['data.memberId', 'data.member_id', 'memberId']
        }
      }
    ],
    fromRequestHeader: ['x-access-token', 'authorization']
  },

  expiry: {
    type: 'absolute',
    defaultSeconds: 86400
  }
}
