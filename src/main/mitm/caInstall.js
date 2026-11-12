import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import fs from 'node:fs'
import { isCaInstalled } from './caTrust.js'

const exec = promisify(execFile)
const PS = ['-NoProfile', '-NonInteractive', '-Command']

/**
 * 把 CA 装进「当前用户 / 受信任根」。
 *
 * 走 CurrentUser 而不是 LocalMachine，是为了避开 UAC —— 客户机上装个工具就弹管理员授权是大忌。
 * 装完必须用指纹复核一遍：PowerShell 脚本自己吞错的可能性太大（末尾输出 'ok' 就返回 0），
 * 只有真去存储里查到证书才算成功。
 *
 * 设置页的「安装」按钮和托盘菜单的引导都走这里，避免两份实现漂移。
 */
export async function installCa(ca, tempDir) {
  if (process.platform !== 'win32') {
    return { ok: false, message: '当前系统请手动导入根证书，详见导出的证书文件' }
  }

  try {
    const pemPath = join(tempDir, 'cinema-auth-ca.pem')
    fs.writeFileSync(pemPath, ca.getCaPem(), 'utf8')

    const script = [
      `$path='${pemPath.replace(/'/g, "''")}'`,
      '$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($path)',
      "$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser')",
      "$store.Open('ReadWrite')",
      '$store.Add($cert)',
      '$store.Close()',
      "'ok'"
    ].join('\n')

    await exec('powershell', [...PS, script], { windowsHide: true, timeout: 30000 })

    const installed = await isCaInstalled(ca.getFingerprint(), { force: true })
    return { ok: installed, message: installed ? '证书已安装' : '安装后校验未通过' }
  } catch (e) {
    return { ok: false, message: e.message }
  }
}
