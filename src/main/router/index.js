import EventRoute from './EventRoute'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import fs from 'node:fs'
import { mergeRules } from '../collectors/rules/index.js'
import { pickValues } from '../collectors/ParamCollector.js'

const exec = promisify(execFile)
const PS = ['-NoProfile', '-NonInteractive', '-Command']

const routers = []

function ps(script) {
  return exec('powershell', [...PS, script], { windowsHide: true, timeout: 30000 })
}

routers.push(
  new EventRoute('auth:status', 'invoke', async (api) => {
    return api.ctx.auth.status()
  })
)

// 登录：接口地址固定取 config/endpoints.js，与会员端同一套服务端，用户无需配置
routers.push(
  new EventRoute('auth:login', 'invoke', async (api, data) => {
    const { phone, password } = data.params || {}
    try {
      return { ok: true, auth: await api.ctx.auth.signIn({ phone, password }) }
    } catch (e) {
      return { ok: false, message: e.message }
    }
  })
)

routers.push(
  new EventRoute('auth:logout', 'invoke', async (api) => {
    try {
      return { ok: true, auth: await api.ctx.auth.signOut() }
    } catch (e) {
      return { ok: false, message: e.message }
    }
  })
)

routers.push(
  new EventRoute('auth:refresh', 'invoke', async (api) => {
    try {
      return { ok: true, auth: await api.ctx.auth.refresh() }
    } catch (e) {
      return { ok: false, message: e.message }
    }
  })
)

// 影城：会员名下的出票系统 → 影城（出票程序）树；账号数由服务端带回来
// 路径与 H5 会员端一致：/web/cinema-accounts/group-tree（复数 accounts，按文件名挂载）
routers.push(
  new EventRoute('cinemas:tree', 'invoke', async (api) => {
    try {
      const data = await api.ctx.auth.get('/web/cinema-accounts/group-tree')
      return {
        ok: true,
        tree: data.tree || [],
        autoRenew: api.ctx.config.get('cinemas.autoRenew') || {}
      }
    } catch (e) {
      return { ok: false, message: e.message, status: e.status || 0 }
    }
  })
)

// 影城下的出票账号（表格里按账号逐行展开，所以选中系统后按影城批量拉）
routers.push(
  new EventRoute('cinemas:accounts', 'invoke', async (api, data) => {
    const cinemaGroupId = Number((data.params || {}).cinemaGroupId || 0)
    if (!cinemaGroupId) return { ok: false, message: '缺少影城 ID' }
    try {
      const res = await api.ctx.auth.get(
        `/web/cinema-accounts/list?cinemaGroupId=${cinemaGroupId}`
      )
      return { ok: true, lists: res.lists || [] }
    } catch (e) {
      return { ok: false, message: e.message, status: e.status || 0 }
    }
  })
)

// 「自动续期」开关：目前只做本地持久化，续期执行逻辑待接
routers.push(
  new EventRoute('cinemas:auto-renew', 'invoke', async (api, data) => {
    const { cinemaGroupId, enabled } = data.params || {}
    if (!cinemaGroupId) return { ok: false, message: '缺少影城 ID' }
    const map = { ...(api.ctx.config.get('cinemas.autoRenew') || {}) }
    map[cinemaGroupId] = Boolean(enabled)
    api.ctx.config.set('cinemas.autoRenew', map)
    return { ok: true, autoRenew: map }
  })
)

/**
 * 参数弹窗的「获取参数」：按该影城的抓包字段清单去抓包记录里捞值。
 * 先把已有记录扫一遍（用户可能刚登录过），没凑齐就等新流量进来，直到超时。
 * 需要该系统有抓包规则 —— 没有规则意味着代理连流量都不解密，抓不到东西。
 */
routers.push(
  new EventRoute('cinemas:capture-params', 'invoke', async (api, data) => {
    const { ctx } = api
    const params = data.params || {}
    const keys = Array.isArray(params.keys)
      ? [...new Set(params.keys.filter(Boolean).map(String))]
      : []
    const systemCode = String(params.systemCode || '')
    if (!keys.length) return { ok: false, message: '该影城没有配置抓包参数' }

    const rule = ctx.extractor.activeRules.find((r) => r.id === systemCode)
    if (!rule) {
      return {
        ok: false,
        message: systemCode
          ? `系统「${systemCode}」没有抓包规则，无法自动获取`
          : '该影城没有关联出票系统，无法确定抓包规则'
      }
    }

    if (!ctx.proxyRunning) {
      try {
        await ctx.startProxy()
      } catch (e) {
        return { ok: false, message: `抓包代理启动失败：${e.message}` }
      }
    }

    const values = {}
    // 只回扫最近 200 条：更早的基本是别的系统，翻全量没意义还慢
    let scanned = Math.max(0, ctx.captures.length - 200)
    const scanNew = () => {
      const list = ctx.captures
      if (list.length < scanned) scanned = 0 // 缓冲被截断过，从头再扫
      for (let i = scanned; i < list.length; i += 1) {
        const record = list[i]
        if (ctx.extractor.hostMatches(rule, record.host)) {
          Object.assign(values, pickValues(record, keys))
        }
      }
      scanned = list.length
    }

    scanNew()
    const waitMs = Math.min(Math.max(Number(params.waitMs) || 20000, 3000), 60000)
    const deadline = Date.now() + waitMs
    while (keys.some((key) => !values[key]) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 700))
      scanNew()
    }

    return {
      ok: true,
      values,
      missing: keys.filter((key) => !values[key]),
      proxyRunning: ctx.proxyRunning
    }
  })
)

routers.push(
  new EventRoute('proxy:start', 'invoke', async (api) => {
    try {
      return await api.ctx.startProxy()
    } catch (e) {
      return { running: false, error: e.message }
    }
  })
)

routers.push(
  new EventRoute('proxy:stop', 'invoke', async (api) => {
    try {
      return await api.ctx.stopProxy()
    } catch (e) {
      return { running: false, error: e.message }
    }
  })
)

routers.push(
  new EventRoute('proxy:status', 'invoke', async (api) => {
    const { ctx } = api
    const sysProxy = await ctx.systemProxy.read().catch(() => ({}))
    return {
      running: ctx.proxyRunning,
      port: ctx.proxy.port,
      stats: ctx.proxy.stats,
      systemProxy: sysProxy,
      platform: process.platform
    }
  })
)

routers.push(
  new EventRoute('credentials:list', 'invoke', async (api) => {
    const list = api.ctx.credentials.list()
    return list.map((item) => ({
      ...item,
      remainingSeconds: item.expiresAt
        ? Math.round((item.expiresAt - Date.now()) / 1000)
        : null
    }))
  })
)

routers.push(
  new EventRoute('credentials:copy', 'invoke', async (api, data) => {
    const { ruleId } = data.params || {}
    const entry = api.ctx.credentials.getToken(ruleId)
    if (!entry) return { ok: false, message: '未找到该系统的凭证' }
    // extras 是主凭证之外的附加字段（如鲸鱼系统的 refreshToken），明文只在这里出现一次
    return { ok: true, token: entry.token, extras: entry.extras || null }
  })
)

routers.push(
  new EventRoute('credentials:remove', 'invoke', async (api, data) => {
    const { ruleId } = data.params || {}
    const ok = api.ctx.credentials.remove(ruleId)
    return { ok }
  })
)

routers.push(
  new EventRoute('config:get', 'invoke', async (api) => {
    return api.ctx.config.data
  })
)

routers.push(
  new EventRoute('config:update', 'invoke', async (api, data) => {
    const patch = data.params || {}
    const updated = api.ctx.config.update(patch)

    // 配置变了，规则和白名单要立刻生效，不能等下次启动
    api.ctx.extractor.setRules(mergeRules(updated.rules))

    return updated
  })
)

routers.push(
  new EventRoute('rules:list', 'invoke', async (api) => {
    return api.ctx.extractor.activeRules.map((r) => ({
      id: r.id,
      name: r.name,
      hosts: r.hosts || [],
      enabled: r.enabled !== false,
      expiry: r.expiry
    }))
  })
)

routers.push(
  new EventRoute('ca:info', 'invoke', async (api) => {
    const { ctx } = api
    return {
      fingerprint: ctx.ca.getFingerprint(),
      notAfter: ctx.ca.caCert?.validity?.notAfter || null,
      installed: await checkCaInstalled(ctx.ca.getFingerprint())
    }
  })
)

routers.push(
  new EventRoute('ca:check', 'invoke', async (api) => {
    return { installed: await checkCaInstalled(api.ctx.ca.getFingerprint()) }
  })
)

routers.push(
  new EventRoute('ca:install', 'invoke', async (api) => {
    const { ctx } = api
    if (process.platform !== 'win32') {
      return { ok: false, message: '当前系统请手动导入根证书，详见导出的证书文件' }
    }

    try {
      const pemPath = join(api.app.getPath('temp'), 'cinema-auth-ca.pem')
      fs.writeFileSync(pemPath, ctx.ca.getCaPem(), 'utf8')

      // 装到「当前用户」的受信任根，避开 UAC —— 客户机装软件弹管理员授权是大忌
      const script = [
        `$path='${pemPath.replace(/'/g, "''")}'`,
        '$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($path)',
        "$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser')",
        "$store.Open('ReadWrite')",
        '$store.Add($cert)',
        '$store.Close()',
        "'ok'"
      ].join('\n')

      await ps(script)
      const installed = await checkCaInstalled(ctx.ca.getFingerprint())
      return { ok: installed, message: installed ? '证书已安装' : '安装后校验未通过' }
    } catch (e) {
      return { ok: false, message: e.message }
    }
  })
)

routers.push(
  new EventRoute('ca:uninstall', 'invoke', async (api) => {
    if (process.platform !== 'win32') return { ok: false, message: '暂不支持自动卸载' }
    try {
      const thumb = api.ctx.ca.getFingerprint().replace(/:/g, '')
      const script = [
        `$tp='${thumb}'`,
        'Get-ChildItem Cert:\\CurrentUser\\Root |',
        '  Where-Object { $_.Thumbprint -eq $tp } |',
        '  Remove-Item -Force',
        "'ok'"
      ].join('\n')
      await ps(script)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e.message }
    }
  })
)

routers.push(
  new EventRoute('ca:export', 'invoke', async (api) => {
    const { dialog } = api
    const result = await dialog.showSaveDialog({
      title: '导出根证书',
      defaultPath: 'cinema-auth-ca.crt',
      filters: [{ name: '证书', extensions: ['crt', 'pem'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false }
    fs.writeFileSync(result.filePath, api.ctx.ca.getCaPem(), 'utf8')
    return { ok: true, path: result.filePath }
  })
)

routers.push(
  new EventRoute('logs:list', 'invoke', async (api) => api.ctx.logs.slice(-200))
)

routers.push(
  new EventRoute('logs:clear', 'invoke', async (api) => {
    api.ctx.logs = []
    return { ok: true }
  })
)

routers.push(
  new EventRoute('captures:list', 'invoke', async (api) => {
    return api.ctx.captures.slice(-100).map((c) => ({
      id: c.id,
      at: c.at,
      host: c.host,
      method: c.method,
      path: c.path,
      statusCode: c.statusCode,
      duration: c.duration
    }))
  })
)

routers.push(
  new EventRoute('captures:clear', 'invoke', async (api) => {
    api.ctx.captures = []
    return { ok: true }
  })
)

routers.push(
  new EventRoute('reporter:test', 'invoke', async (api) => {
    return api.ctx.reporter.test()
  })
)

routers.push(
  new EventRoute('app:info', 'invoke', async (api) => {
    return {
      version: api.app.getVersion(),
      platform: process.platform,
      dataDir: api.ctx.dataDir,
      agentId: api.ctx.reporter.agentId,
      proxyRunning: api.ctx.proxyRunning
    }
  })
)

routers.push(
  new EventRoute('app:open-data-dir', 'invoke', async (api) => {
    await exec(process.platform === 'win32' ? 'explorer' : 'open', [api.ctx.dataDir]).catch(
      () => {}
    )
    return { ok: true }
  })
)

routers.push(
  new EventRoute('autolaunch:set', 'invoke', async (api, data) => {
    const { enabled } = data.params || {}
    api.app.setLoginItemSettings({ openAtLogin: Boolean(enabled) })
    return { ok: true, enabled: Boolean(enabled) }
  })
)

/**
 * 判断根证书是否已在「当前用户 / 受信任根」里。
 * 用 SHA1 指纹比对，不比对主题名 —— 主题名可以伪造，指纹不会。
 */
async function checkCaInstalled(fingerprint) {
  if (process.platform !== 'win32') return false
  try {
    const thumb = fingerprint.replace(/:/g, '')
    const script = [
      `$tp='${thumb}'`,
      "$found = Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq $tp }",
      'if ($found) { "yes" } else { "no" }'
    ].join('\n')
    const { stdout } = await ps(script)
    return stdout.trim() === 'yes'
  } catch {
    return false
  }
}

export default routers
