import gyyse from './gyyse'
import yipiaotong from './yipiaotong'
import whale from './whale'
import starOpen from './star-open'
import starCapi from './star-capi'
import phoenix from './phoenix'
import phoenixJiaying from './phoenix-jiaying'
import lumenbird from './lumenbird'
import sys365 from './365'
import sys360 from './360'
import mini from './mini'
import suiying from './suiying'
import pandl from './pandl'
import wonder from './wonder'
import ruiziyou from './ruiziyou'
import tonul from './tonul'
import jintaotao from './jintaotao'
import sys1905 from './1905'
import douyou from './douyou'
import jmtnt from './jmtnt'
import hypiao from './hypiao'
import lumiai from './lumiai'
import bona from './bona'
import laiyipiao from './laiyipiao'
import liegou from './liegou'
import yingban from './yingban'
import walland from './walland'

/**
 * 一票通定制分支。
 *
 * 交付给一票通客户时，从 defaultRules 里把 whale（鲸鱼系统）摘掉即可，
 * 规则文件留在仓库里不影响打包。HK 票务同理，需要时加回来就行，
 * 都不用从别的分支拷代码。
 */
export const defaultRules = [
  starOpen,
  starCapi,
  yipiaotong,
  gyyse,
  whale,
  phoenix,
  phoenixJiaying,
  lumenbird,
  sys365,
  sys360,
  mini,
  suiying,
  pandl,
  wonder,
  ruiziyou,
  tonul,
  jintaotao,
  sys1905,
  douyou,
  jmtnt,
  hypiao,
  lumiai,
  bona,
  laiyipiao,
  liegou,
  yingban,
  walland
]

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
