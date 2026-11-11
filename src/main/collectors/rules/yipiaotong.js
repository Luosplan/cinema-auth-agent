/**
 * 一票通票务系统。
 *
 * ⚠ 待补充真实参数（见下方 TODO）。在 hosts 填好之前这条规则不会抓任何流量，
 *   不会误伤客户机上的其他网站，可以放心保留在默认配置里。
 *
 * 需要确认的三件事：
 *   1. 小程序 / 后台的接口域名（抓一次包，看 Host 头）
 *   2. 登录接口路径与响应里 token 的字段名
 *   3. 会话是滑动续期还是会绝对过期
 *
 * tokenPaths 已经预置了国内票务系统最常见的几种命名，
 * 通常抓到一次登录响应就能直接命中，不必逐个试。
 */
export default {
  id: 'yipiaotong',
  name: '一票通',
  enabled: true,
  // TODO: 待填，例如 ['app.yipiaotong.com', '*.yipiaotong.com']
  hosts: [],

  // hosts 填好之后，「获取参数」就能用了
  params: ['mobile', 'authorization', 'token'],
  capture: {
    fromResponse: [
      {
        when: {
          method: 'POST',
          pathIncludes: ['/login', '/loginma', '/wxLogin', '/auth']
        },
        tokenPaths: [
          'data.token',
          'data.accessToken',
          'data.access_token',
          'data.thirdSession',
          'data.sessionId',
          'data.session',
          'token',
          'accessToken'
        ],
        accountPaths: [
          'data.nickName',
          'data.userName',
          'data.mobile',
          'data.userId',
          'data.openid'
        ],
        expirePaths: ['data.expiresIn', 'data.expireTime', 'data.expireAt', 'expiresIn']
      }
    ],
    fromRequestHeader: ['third-session', 'authorization', 'x-token', 'token']
  },
  expiry: {
    type: 'sliding',
    idleSeconds: 1800
  }
}
