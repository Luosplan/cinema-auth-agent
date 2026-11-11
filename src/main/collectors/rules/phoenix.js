/**
 * 凤凰云智（phoenix）—— 悦客云/阿里 mtop 体系。
 *
 * phoenix-h5 / phoenix-mini 两个物理目录在服务端已合并为一个 System.code = phoenix，
 * 靠 CinemaGroup.protocol（h5 / miniapp）区分端，所以这里也只有一条规则。
 *
 *   域名      mtop.yuekeyun.com（h5 页面挂在各家影城自己的域名下，入口走 accessUrl）
 *   H5 端     会话凭证是 cookie 里的 _m_h5_tk / larkSid / tid，
 *             过期后按 tid 调 mtop.alipic.lark.own.auth.getsidbytid 换新 sid（滑动续期）
 *   小程序端  accessToken / refreshToken，
 *             刷新走 mtop.alipic.lark.account.authn.refresh
 *
 * mtop 响应会再包一层 { data: { ... } }，tokenPaths 两层都写。
 * H5 的 _m_h5_tk 在 cookie 里，不在 JSON 响应里 —— 主凭证靠参数弹窗的 cookie 抓取，
 * 这里的 fromResponse 兜的是小程序端的登录/刷新响应。
 */
export default {
  id: 'phoenix',
  name: '凤凰云智',
  enabled: true,
  hosts: ['mtop.yuekeyun.com', '*.yuekeyun.com'],

  launch: {
    type: 'h5',
    name: '凤凰云智'
  },

  params: [
    { key: 'mobile', required: true },
    { key: 'token', required: true },
    { key: 'refreshtoken', required: false },
    // larkSid / tid 是 H5 端会话的核心，前台源码里叫 sid，靠 cookie / 页面存储抓到
    { key: 'larksid', required: false },
    { key: 'tid', required: false }
  ],

  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['authn', 'login', 'getsidbytid'] },
        tokenPaths: ['data.accessToken', 'data.data.accessToken', 'data.token', 'accessToken'],
        accountPaths: ['data.mobile', 'data.data.mobile', 'data.nickName', 'data.userId'],
        expirePaths: ['data.expiresTime', 'data.expiresIn', 'data.data.expiresTime'],
        extraPaths: {
          refreshToken: ['data.refreshToken', 'data.data.refreshToken'],
          sid: ['data.sid', 'data.data.sid', 'data.bizValue']
        }
      }
    ],
    fromRequestHeader: ['authorization', 'x-m-h5-token']
  },

  expiry: {
    // 两端都有真实刷新（getsidbytid / authn.refresh），按滑动续期估算
    type: 'sliding',
    idleSeconds: 7200
  }
}
