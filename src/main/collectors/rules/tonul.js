/**
 * 派蒙系统（tonul，海宁派盟）。
 *
 *   域名      hainingpaimeng.tonul.cn（tonul.cn 主域通配兜底）
 *   接口风格  .do 表单（application/x-www-form-urlencoded），全部 POST
 *   鉴权      body 里的 sessionKey + miniUserId 标识用户；
 *             token 字段是每请求按 body 算的 MD5，动态生成，**不用抓也别抓**
 *   账号      sessionKey / miniUserId（+ 可选会员卡 cardId）
 *
 * 坑：body 里也有个名叫 token 的字段，但它是签名不是凭证 —— 按名匹配抓到它没意义，
 * 这套系统要认的是 sessionKey / miniUserId。
 */
export default {
  id: 'tonul',
  name: '派蒙系统',
  enabled: true,
  hosts: ['hainingpaimeng.tonul.cn', '*.tonul.cn'],

  launch: {
    type: 'miniapp',
    name: '派蒙影城'
  },

  params: [
    { key: 'mobile', required: false },
    { key: 'sessionKey', label: 'sessionKey', required: true },
    { key: 'miniUserId', label: 'miniUserId', required: true }
  ],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['login', 'Login', 'auth'] },
        tokenPaths: ['data.sessionKey', 'sessionKey', 'data.session_key', 'session_key'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.miniUserId', 'mobile'],
        expirePaths: ['data.expiresIn', 'data.expireTime'],
        extraPaths: {
          miniUserId: ['data.miniUserId', 'miniUserId', 'data.userId', 'userId']
        }
      }
    ],
    // body 里的 token 是签名，不在头里；头里也没有可兜底的凭证
    fromRequestHeader: []
  },

  expiry: {
    type: 'sliding',
    idleSeconds: 7200
  }
}
