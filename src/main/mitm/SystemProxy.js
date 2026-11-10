import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const PS = ['-NoProfile', '-NonInteractive', '-Command']

const WIN_REG_PATH = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

function run(cmd, args, opts = {}) {
  return exec(cmd, args, { windowsHide: true, timeout: 20000, ...opts })
}

/**
 * Windows 的代理设置写在注册表里，但改完必须通知 WinINet 刷新，
 * 否则已经在运行的进程（微信容器进程就在此列）仍然用旧配置。
 * 39 = INTERNET_OPTION_SETTINGS_CHANGED，37 = INTERNET_OPTION_REFRESH
 */
const WIN_REFRESH_SNIPPET = [
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class CaaWinInet {',
  '  [DllImport("wininet.dll", SetLastError = true)]',
  '  public static extern bool InternetSetOption(IntPtr h, int opt, IntPtr buf, int len);',
  '}',
  "'@",
  '[void][CaaWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)',
  '[void][CaaWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)'
].join('\n')

/**
 * 系统代理接管与还原。
 *
 * 设计原则：任何一次 enable 之前都先完整备份原始配置，
 * 应用退出、崩溃重启、用户手动关闭代理这三条路径都要能还原干净。
 * 绝不能出现「关掉软件后客户浏览器全断网」的事故。
 */
export default class SystemProxy {
  constructor() {
    this.backup = null
    this.active = false
    this.port = 0
  }

  get platform() {
    return process.platform
  }

  /**
   * 读取当前系统代理配置（用于界面展示和故障排查）。
   */
  async read() {
    if (this.platform === 'win32') return this.readWindows()
    if (this.platform === 'darwin') return this.readMac()
    return this.readLinux()
  }

  async readWindows() {
    const script = [
      `$k='${WIN_REG_PATH}'`,
      'if (-not (Test-Path $k)) { "{}"; exit }',
      "$i = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue",
      '[PSCustomObject]@{',
      '  proxyEnable = [int]$i.ProxyEnable',
      '  proxyServer = [string]$i.ProxyServer',
      '  proxyOverride = [string]$i.ProxyOverride',
      '  autoConfigUrl = [string]$i.AutoConfigURL',
      '} | ConvertTo-Json -Compress'
    ].join('\n')

    try {
      const { stdout } = await run('powershell', [...PS, script])
      return JSON.parse(stdout.trim() || '{}')
    } catch (e) {
      return { error: e.message }
    }
  }

  async readMac() {
    try {
      const { stdout } = await run('networksetup', ['-listallnetworkservices'])
      const services = this.parseMacServices(stdout)
      const result = {}
      for (const svc of services) {
        const web = await run('networksetup', ['-getwebproxy', svc])
        result[svc] = web.stdout
      }
      return result
    } catch (e) {
      return { error: e.message }
    }
  }

  async readLinux() {
    try {
      const { stdout } = await run('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])
      return { mode: stdout.trim() }
    } catch (e) {
      return { error: e.message }
    }
  }

  parseMacServices(stdout) {
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('An asterisk') && !s.startsWith('*'))
  }

  /**
   * 接管系统代理。
   * @param {number} port 本地监听端口
   */
  async enable(port) {
    if (this.active) await this.disable()

    this.backup = await this.read()
    this.port = port

    if (this.platform === 'win32') await this.enableWindows(port)
    else if (this.platform === 'darwin') await this.enableMac(port)
    else await this.enableLinux(port)

    this.active = true
    return { port, backup: this.backup }
  }

  async enableWindows(port) {
    const server = `127.0.0.1:${port}`
    const override = '<local>;127.*;10.*;172.16.*;192.168.*;localhost'

    const script = [
      `$k='${WIN_REG_PATH}'`,
      'Set-ItemProperty -Path $k -Name ProxyEnable -Value 1 -Type DWord',
      `Set-ItemProperty -Path $k -Name ProxyServer -Value '${server}' -Type String`,
      `Set-ItemProperty -Path $k -Name ProxyOverride -Value '${override}' -Type String`,
      WIN_REFRESH_SNIPPET
    ].join('\n')

    await run('powershell', [...PS, script])
  }

  async enableMac(port) {
    const services = this.parseMacServices(
      (await run('networksetup', ['-listallnetworkservices'])).stdout
    )
    for (const svc of services) {
      await run('networksetup', ['-setwebproxy', svc, '127.0.0.1', String(port)])
      await run('networksetup', ['-setsecurewebproxy', svc, '127.0.0.1', String(port)])
      await run('networksetup', ['-setwebproxystate', svc, 'on'])
      await run('networksetup', ['-setsecurewebproxystate', svc, 'on'])
    }
    this.backup = { services }
  }

  async enableLinux(port) {
    const p = String(port)
    await run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'manual'])
    await run('gsettings', ['set', 'org.gnome.system.proxy.http', 'host', '127.0.0.1'])
    await run('gsettings', ['set', 'org.gnome.system.proxy.http', 'port', p])
    await run('gsettings', ['set', 'org.gnome.system.proxy.https', 'host', '127.0.0.1'])
    await run('gsettings', ['set', 'org.gnome.system.proxy.https', 'port', p])
  }

  /**
   * 用外部备份还原。用于崩溃恢复：进程上次被强杀时内存里的备份已经丢了，
   * 只能靠启动时从 lock 文件里读回来。
   */
  async restoreFrom(backup) {
    this.backup = backup || {}
    this.active = true
    return this.disable()
  }

  /**
   * 还原系统代理。任何异常都不能阻断，最好情况是至少恢复到「关闭」状态。
   */
  async disable() {
    if (!this.active) return { restored: false }

    try {
      if (this.platform === 'win32') await this.disableWindows()
      else if (this.platform === 'darwin') await this.disableMac()
      else await this.disableLinux()
    } finally {
      this.active = false
    }

    return { restored: true }
  }

  async disableWindows() {
    const b = this.backup || {}
    const enable = Number(b.proxyEnable) === 1 ? 1 : 0
    const server = b.proxyServer || ''
    const override = b.proxyOverride || ''

    const script = [
      `$k='${WIN_REG_PATH}'`,
      `Set-ItemProperty -Path $k -Name ProxyEnable -Value ${enable} -Type DWord`,
      `Set-ItemProperty -Path $k -Name ProxyServer -Value '${server}' -Type String`,
      `Set-ItemProperty -Path $k -Name ProxyOverride -Value '${override}' -Type String`,
      WIN_REFRESH_SNIPPET
    ].join('\n')

    await run('powershell', [...PS, script])
  }

  async disableMac() {
    const services = this.backup?.services || []
    for (const svc of services) {
      await run('networksetup', ['-setwebproxystate', svc, 'off'])
      await run('networksetup', ['-setsecurewebproxystate', svc, 'off'])
    }
  }

  async disableLinux() {
    await run('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'none'])
  }
}
