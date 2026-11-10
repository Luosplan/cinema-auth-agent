import gyyse from './gyyse'
import yipiaotong from './yipiaotong'
import hkticketing from './hkticketing'

export const defaultRules = [yipiaotong, hkticketing, gyyse]

/**
 * 把用户配置里的覆盖项合并到默认规则上。
 * 只允许覆盖业务字段，id 不可变，避免配置改坏后规则错位。
 */
export function mergeRules(overrides = {}) {
  return defaultRules.map((rule) => {
    const patch = overrides[rule.id]
    if (!patch) return { ...rule }
    return {
      ...rule,
      ...patch,
      id: rule.id,
      capture: {
        ...rule.capture,
        ...(patch.capture || {})
      },
      expiry: {
        ...rule.expiry,
        ...(patch.expiry || {})
      }
    }
  })
}

export default defaultRules
