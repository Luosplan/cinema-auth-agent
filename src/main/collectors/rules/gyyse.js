/**
 * 象塑光影系统（gyyse）—— 参考实现。
 *
 * 这套规则是从服务端适配器里反推出来的真实数据，可作为编写其他系统规则的样本：
 *   登录接口：POST /mallapi/wxuser/loginma   body: { code }
 *   响应结构：{ code: 0, msg, data: { id, nickName, thirdSession } }
 *   鉴权方式：请求头 third-session
 *   续期特性：滑动续期，实测断连 15 小时以上仍有效
 */
export default {
  id: 'gyyse',
  name: '象塑光影',
  enabled: true,
  hosts: ['app.app.gyyse.com', '*.gyyse.com'],
  capture: {
    fromResponse: [
      {
        when: { method: 'POST', pathIncludes: ['/wxuser/loginma'] },
        tokenPaths: ['data.thirdSession'],
        accountPaths: ['data.nickName', 'data.mobile', 'data.id'],
        expirePaths: ['data.expiresIn', 'data.expireTime']
      }
    ],
    fromRequestHeader: ['third-session']
  },
  expiry: {
    type: 'sliding',
    idleSeconds: 7200
  }
}
