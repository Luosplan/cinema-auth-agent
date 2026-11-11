/**
 * 鲸鱼系统（jingyumovie.cn）。
 *
 * 参数来自反编译小程序 `wx9a6601603b142690`（BMC 影城，app-service.js 的 api/request.js）
 * 并与服务端 `ticket-adapters/whale` 的适配器交叉核对：
 *
 *   基础地址：https://cygg.jingyumovie.cn:48080   （芋道 yudao 体系的 /app-api 风格）
 *   登录接口：POST /app-api/member/auth/weixin-mini-app-login   body: { code }
 *   响应结构：{ code: 0, data: { userId, accessToken, refreshToken, expiresTime } }
 *   鉴权方式：请求头 Authorization: Bearer <accessToken>
 *            另外每个业务请求还要带 tenant-id（由服务端 ticketParams.header 提供，与抓取无关）
 *   刷新接口：POST /app-api/member/auth/refresh-token?refreshToken=xxx
 *
 * ⚠ 服务端 captureConfig 要的是 accessToken 和 refreshToken 两个值，
 *   所以 refreshToken 走 extraPaths 一并取回，只抓一个等于没抓。
 *
 * ⚠ hosts 只写域名不写端口。代理是按 CONNECT 的 host 匹配的，
 *   48080 这个非标准端口不影响命中。
 */
export default {
  id: 'whale',
  name: '鲸鱼系统',
  enabled: true,
  hosts: ['cygg.jingyumovie.cn', '*.jingyumovie.cn'],

  launch: {
    type: 'miniapp',
    name: '鲸鱼影城',
    appid: 'wx9a6601603b142690'
  },

  // 服务端要的是 accessToken + refreshToken，顺带把手机号取回来
  params: ['mobile', 'authorization', 'refreshtoken'],
  capture: {
    fromResponse: [
      {
        when: {
          method: 'POST',
          pathIncludes: ['weixin-mini-app-login', 'refresh-token']
        },
        tokenPaths: ['data.accessToken'],
        accountPaths: ['data.mobile', 'data.nickname', 'data.userId'],
        expirePaths: ['data.expiresTime'],
        extraPaths: {
          refreshToken: ['data.refreshToken']
        }
      }
    ],
    // 兜底：小程序改版后登录接口变了，至少还能从业务请求头里捞到 accessToken
    fromRequestHeader: ['authorization']
  },
  expiry: {
    // yudao 的 accessToken 是绝对过期，响应里带 expiresTime（毫秒时间戳）
    // 取不到时按 1 天估算，宁可显示得保守一点，也不要假装永久有效
    type: 'absolute',
    defaultSeconds: 86400
  }
}
