import gyyse from './gyyse'
import yipiaotong from './yipiaotong'
import whale from './whale'

/**
 * 一票通定制分支。
 *
 * 交付给一票通客户时，从 defaultRules 里把 whale（鲸鱼系统）摘掉即可，
 * 规则文件留在仓库里不影响打包。HK 票务同理，需要时加回来就行，
 * 都不用从别的分支拷代码。
 */
export const defaultRules = [yipiaotong, gyyse, whale]

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
