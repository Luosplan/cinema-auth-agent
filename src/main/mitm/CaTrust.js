import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const PS = ['-NoProfile', '-NonInteractive', '-Command']

/**
 * 查询结果缓存。
 *
 * 每次查证书都要起一个 PowerShell（本机上 300ms～2s 不等），而「获取参数」的路径上
 * 原来会查两次（capture-params 一次、startProxy 里再一次），点一下按钮就先白等一两秒。
 * 证书装/卸只可能由本程序触发（ca:install / ca:uninstall 会清缓存），
 * 所以短 TTL 缓存不会把「用户在 certmgr 里手删」这种情况藏太久。
 */
const CACHE_TTL = 30 * 1000
let cache = { thumb: '', result: '', at: 0 }

/** 装 / 卸证书后必须清掉，否则接下来 30 秒都按旧结论走 */
export function invalidateCaCache() {
  cache = { thumb: '', result: '', at: 0 }
}

/**
 * 探测根证书是否已在「当前用户 / 受信任的根证书颁发机构」里。
 *
 * 返回三态而不是布尔：
 *   'yes'     确实在
 *   'no'      确实不在
 *   'unknown' 查不到（非 Windows、PowerShell 超时 / 被杀）
 *
 * 必须区分后两者：`startProxy` 那种「拦住」的场景把 unknown 当 no 是安全的，
 * 但「证书没了就停采集」要是把一次 PowerShell 抖动当成「证书被删」，
 * 就会平白停掉正在跑的采集。所以底层只报事实，怎么解读交给调用方。
 *
 * 用 SHA1 指纹比对，不比对主题名 —— 主题名可以伪造，指纹不会。
 *
 * @param {string} fingerprint
 * @param {{ fresh?: boolean }} [options] fresh=true 跳过缓存（界面主动刷状态时用）
 */
export async function probeCaInstalled(fingerprint, options = {}) {
  if (process.platform !== 'win32') return 'unknown'

  const thumb = String(fingerprint || '').replace(/:/g, '')
  if (!thumb) return 'unknown'

  const now = Date.now()
  if (!options.fresh && cache.thumb === thumb && now - cache.at < CACHE_TTL) {
    return cache.result
  }

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
    const out = stdout.trim()
    if (out === 'yes' || out === 'no') {
      cache = { thumb, result: out, at: Date.now() }
      return out
    }
    // unknown 不缓存：抖动一次不代表事实，下一次还得真查
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 布尔版：查不到一律当没装。启动采集、抓包前校验这类「宁可拦住」的场景用它 */
export async function checkCaInstalled(fingerprint) {
  return (await probeCaInstalled(fingerprint)) === 'yes'
}
