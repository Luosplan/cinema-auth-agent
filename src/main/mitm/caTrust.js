import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const PS = ['-NoProfile', '-NonInteractive', '-Command']

/**
 * 查一次证书要走一次 PowerShell 冷启动（实测 400ms 上下）。
 * 点「开始采集」时如果每次都现查，按钮就会明显卡一下 —— 索性缓存 60 秒：
 * 装 / 卸证书时主动失效，用户手动去 certmgr 删证书这种情况，最坏也就多等一分钟。
 */
const TTL = 60 * 1000
const cache = new Map()

/** 装、卸证书之后必须调一次，否则缓存会把旧结论兜回来 */
export function invalidateCaCache() {
  cache.clear()
}

/**
 * 判断根证书是否已在「当前用户 / 受信任根」里。
 *
 * 用 SHA1 指纹比对，不比对主题名 —— 主题名可以伪造，指纹不会。
 * 探针脚本只输出 yes/no：缺少证书时 Get-ChildItem 不报错、返回空，
 * 靠字符串判断最稳。
 *
 * @param {string} fingerprint SHA1 指纹，可带冒号
 * @param {{ force?: boolean }} [opts] force=true 跳过缓存（安装/卸载后的复核）
 */
export async function isCaInstalled(fingerprint, opts = {}) {
  if (process.platform !== 'win32') return false
  const thumb = String(fingerprint || '')
    .replace(/:/g, '')
    .toUpperCase()
  if (!thumb) return false

  const hit = cache.get(thumb)
  if (!opts.force && hit && Date.now() - hit.at < TTL) return hit.ok

  let ok = false
  let settled = false
  try {
    const script = [
      `$tp='${thumb}'`,
      '$found = Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq $tp }',
      'if ($found) { "yes" } else { "no" }'
    ].join('\n')
    const { stdout } = await exec('powershell', [...PS, script], {
      windowsHide: true,
      timeout: 30000
    })
    ok = stdout.trim() === 'yes'
    settled = true
  } catch {
    // 查询本身失败时按「未安装」处理：宁可不启动，也不要带病启动假装采集中
    ok = false
  }

  // 探针没跑通（超时、PowerShell 被杀）不写缓存，下次点击重新问一遍
  if (settled) cache.set(thumb, { ok, at: Date.now() })
  return ok
}
