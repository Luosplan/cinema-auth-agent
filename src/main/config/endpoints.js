/**
 * 出票系统（ticket-server）接口地址（单一来源）。
 *
 * 登录、影城列表都走这套服务端，所以地址不该让用户填 —— 装上就能用。
 * 默认指向 HK 票务线上服；本地联调时用环境变量 CINEMA_API_BASE 覆盖，界面无需改动。
 * 接口路径固定为 /api 前缀（与 ticket-server 的挂载方式一致）。
 */
export const DEFAULT_API_BASE = 'https://203.195.196.67/api'

export function resolveApiBase() {
  const fromEnv = String(process.env.CINEMA_API_BASE || '').trim()
  return fromEnv || DEFAULT_API_BASE
}
