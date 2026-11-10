/**
 * 会员端接口地址（单一来源）。
 *
 * 登录/续期/退出复用会员端（H5、小程序）同一套服务端接口，
 * 所以这个地址不该让用户填 —— 装上就应该能直接登录。
 *
 * 默认指向本地开发服（smart-bid-ticket-server，端口 5000）；
 * 出线上包时改这一行，或用环境变量 CINEMA_API_BASE 覆盖，界面无需改动。
 */
export const DEFAULT_API_BASE = 'http://localhost:5000/api'

export function resolveApiBase() {
  const fromEnv = String(process.env.CINEMA_API_BASE || '').trim()
  return fromEnv || DEFAULT_API_BASE
}
