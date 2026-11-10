import gyyse from './gyyse'
import hkticketing from './hkticketing'

/**
 * HK 票务定制分支。
 *
 * 本分支只装载 HK 票务与象塑两套规则，交付给香港客户时界面上不会出现
 * 内地票务系统的配置项。一票通的规则文件仍保留在仓库里，
 * 需要时把下面一行加回来即可，无需从别的分支拷贝代码。
 */
export const defaultRules = [hkticketing, gyyse]

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
