/**
 * 展示层的格式化工具。只做字符串转换，不碰业务判断。
 */

export function formatDateTime(value) {
  if (!value) return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '未知'
  if (seconds <= 0) return '已过期'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${s} 秒`
  return `${s} 秒`
}

/**
 * 凭证健康度。阈值按「够不够撑过一个营业日」来定：
 * 一小时以内就该提醒运营重新打开一次小程序了。
 */
export function levelOfRemaining(seconds) {
  if (seconds == null) return 'unknown'
  if (seconds <= 0) return 'expired'
  if (seconds < 600) return 'danger'
  if (seconds < 3600) return 'warning'
  return 'healthy'
}

export const LEVEL_TEXT = {
  healthy: '正常',
  warning: '即将过期',
  danger: '紧急',
  expired: '已过期',
  unknown: '未知'
}

export const LEVEL_TYPE = {
  healthy: 'success',
  warning: 'warning',
  danger: 'danger',
  expired: 'danger',
  unknown: 'info'
}
