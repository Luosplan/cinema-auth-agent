/**
 * mini 系统（MiniTicket）。
 *
 *   域名      tzl15.xcxyyww.cn/MiniTicket 等 —— 一家影城一个站点，主域通配兜底
 *   登录      表单风格接口（.php），账号抓包凭证：userid / openid / token（+ cardno/mempass）
 *   鉴权      业务请求带 token；请求头 Referer 用影城自己的 appid 拼 servicewechat.com
 *   续期      无独立刷新接口，过期重新抓包
 *
 * 一家影城一个小程序，appid 在影城自己的 accessAppId 里，规则不写死。
 */
export default {
  id: 'mini',
  name: 'mini系统',
  enabled: true,
  hosts: ['tzl15.xcxyyww.cn', '*.xcxyyww.cn'],

  launch: {
    type: 'miniapp',
    name: 'mini影城'
  },

  params: ['mobile', 'token', 'openid', 'memberid'],

  capture: {
    fromResponse: [
      {
        // mini 系登录接口是表单（x-www-form-urlencoded），解析层两种格式都认
        when: { method: 'POST', pathIncludes: ['login', 'Login', 'auth'] },
        tokenPaths: ['data.token', 'token', 'data.accessToken', 'accessToken'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.userid', 'mobile'],
        expirePaths: ['data.expiresIn', 'data.expireTime'],
        extraPaths: {
          openid: ['data.openid', 'openid', 'data.openId'],
          userid: ['data.userid', 'data.userId', 'userid']
        }
      }
    ],
    fromRequestHeader: ['token', 'authorization']
  },

  expiry: {
    type: 'absolute',
    defaultSeconds: 86400
  }
}
