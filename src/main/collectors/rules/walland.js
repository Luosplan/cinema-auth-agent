/**
 * 万蓝德（walland）。
 *
 *   域名      oms.ai-datas.com，接口前缀 /oms-api/miniOpen/**
 *   小程序    wx80bd2e96903adfe8（请求头 Referer 默认指向它）
 *   请求体    { data, head } 双段结构：
 *             head.userToken 是 JWT 登录态，data.authCode 是授权码（一次性）
 *   鉴权      userToken 在 body 里不在请求头 —— fromRequestHeader 兜不到，
 *             靠登录响应路径 + 参数弹窗按名匹配兜底
 */
export default {
  id: 'walland',
  name: '万蓝德',
  enabled: true,
  hosts: ['oms.ai-datas.com', '*.ai-datas.com'],

  launch: {
    type: 'miniapp',
    name: '万蓝德',
    appid: 'wx80bd2e96903adfe8'
  },

  params: ['mobile', 'token'],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['/login', '/auth', 'miniOpen'] },
        tokenPaths: ['data.userToken', 'userToken', 'data.token', 'token', 'head.userToken'],
        accountPaths: ['data.mobile', 'data.nickName', 'data.userId'],
        expirePaths: ['data.expiresIn', 'data.expireTime']
      }
    ],
    fromRequestHeader: ['authorization', 'token']
  },

  expiry: {
    type: 'absolute',
    defaultSeconds: 86400
  }
}
