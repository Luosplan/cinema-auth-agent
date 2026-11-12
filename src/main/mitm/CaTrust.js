import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const PS = ['-NoProfile', '-NonInteractive', '-Command']

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
 */
export async function probeCaInstalled(fingerprint) {
  if (process.platform !== 'win32') return 'unknown'

  const thumb = String(fingerprint || '').replace(/:/g, '')
  if (!thumb) return 'unknown'

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
    if (out === 'yes') return 'yes'
    if (out === 'no') return 'no'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 布尔版：查不到一律当没装。启动采集、抓包前校验这类「宁可拦住」的场景用它 */
export async function checkCaInstalled(fingerprint) {
  return (await probeCaInstalled(fingerprint)) === 'yes'
}
