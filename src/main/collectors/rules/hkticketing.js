/**
 * HK 票务系统。
 *
 * ⚠ 待补充真实参数（见下方 TODO）。hosts 为空时规则整体不生效，不会误抓。
 *
 * 与内地系统的两点差异，写规则时要留意：
 *   1. 香港票务系统大量使用英文头（Authorization / X-Access-Token），
 *      且常见 Bearer 前缀，token 需要在采集后再剥掉前缀。
 *   2. 部分系统返回 snake_case 字段（access_token / expire_in），
 *      tokenPaths 已同时覆盖两种命名。
 */
export default {
  id: 'hkticketing',
  name: 'HK 票务',
  enabled: true,
  // TODO: 待填，例如 ['api.hkticketing.com', '*.hkticketing.com']
  hosts: [],

  // hosts 填好之后，「获取参数」就能用了
  params: ['mobile', 'authorization', 'token'],
  capture: {
    fromResponse: [
      {
        when: {
          method: 'POST',
          pathIncludes: ['/login', '/loginma', '/auth', '/token', '/oauth']
        },
        tokenPaths: [
          'data.access_token',
          'data.accessToken',
          'data.token',
          'data.thirdSession',
          'data.sessionId',
          'access_token',
          'accessToken',
          'token'
        ],
        accountPaths: [
          'data.userName',
          'data.username',
          'data.email',
          'data.mobile',
          'data.userId',
          'data.nickName'
        ],
        expirePaths: [
          'data.expires_in',
          'data.expiresIn',
          'data.expire_in',
          'data.expireAt',
          'expires_in'
        ]
      }
    ],
    fromRequestHeader: ['authorization', 'x-access-token', 'x-token', 'third-session']
  },
  expiry: {
    type: 'absolute',
    defaultSeconds: 7200
  }
}
