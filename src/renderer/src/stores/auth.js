import { reactive } from 'vue'
import { invoke } from '@utils/ipc'

/**
 * 会员登录态。整个渲染进程共用一份，侧栏账号区读它。
 *
 * 账号信息由主进程保管（token 加密落盘、永不回传），
 * 这里只持有脱敏后的展示字段，页面刷新后重新拉一次即可。
 */
export const auth = reactive({
  loaded: false,
  loggedIn: false,
  baseUrl: '',
  deviceId: '',
  expiresAt: null,
  member: null
})

function apply(state) {
  if (!state) return
  auth.loaded = true
  auth.loggedIn = Boolean(state.loggedIn)
  auth.baseUrl = state.baseUrl || ''
  auth.deviceId = state.deviceId || ''
  auth.expiresAt = state.expiresAt || null
  auth.member = state.member || null
}

export async function loadAuth() {
  try {
    apply(await invoke('auth:status'))
  } catch {
    auth.loaded = true
  }
}

export async function login(payload) {
  const res = await invoke('auth:login', payload)
  if (!res?.ok) throw new Error(res?.message || '登录失败')
  apply(res.auth)
  return res.auth
}

export async function logout() {
  const res = await invoke('auth:logout')
  if (!res?.ok) throw new Error(res?.message || '退出失败')
  apply(res.auth)
}

/** 展示名：优先昵称，没有就用手机号（已脱敏） */
export function displayName() {
  const m = auth.member
  if (!m) return '未登录'
  return m.name || m.phone || '已登录'
}

/** 头像取名字或手机号里的第一段字符 */
export function avatarText() {
  const m = auth.member
  if (!m) return ''
  const base = String(m.name || m.phone || '')
  return base.slice(0, 1).toUpperCase() || '·'
}
