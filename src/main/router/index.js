import EventRoute from './EventRoute'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import fs from 'node:fs'
import { mergeRules } from '../collectors/rules/index.js'
import { paramDef, resolveForKeys, normalizeKey, describeParams } from '../collectors/ParamResolver.js'
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
    const { ctx } = api
    try {
      const data = await ctx.auth.get('/web/cinema-accounts/group-tree')
      return {
        ok: true,
        // 入口（accessUrl / accessAppId）由服务端随树带回来，不再本地覆盖
        tree: data.tree || [],
        autoRenew: ctx.config.get('cinemas.autoRenew') || {}
      }
    } catch (e) {
      return { ok: false, message: e.message, status: e.status || 0 }
    }
  })
)

/**
 * 保存某家影城的入口 —— 直接调后台现成的「编辑出票程序」接口。
 *
 * 入口链接（accessUrl / accessAppId）本来就是这个出票程序自己的字段，
 * 后台 `PUT /admin/cinema/cinemaGroups/:id` 早就在维护它们，会员端不需要再开一条写接口。
 * 这里只带这两项，accessType / protocol / ticketParams 一个都不传 ——
 * 那些是出票程序的身份，采集端无权也不该改。
 */
routers.push(
  new EventRoute('cinemas:entry:set', 'invoke', async (api, data) => {
    const params = data.params || {}
    const cinemaGroupId = Number(params.cinemaGroupId || 0)
    if (!cinemaGroupId) return { ok: false, message: '缺少影城 ID' }

    try {
      const row = await api.ctx.auth.put(`/admin/cinema/cinemaGroups/${cinemaGroupId}`, {
        accessUrl: params.url || null,
        accessAppId: params.appid || null
      })
      return {
        ok: true,
        entry: { url: row.accessUrl || '', appid: row.accessAppId || '' }
      }
    } catch (e) {
      return { ok: false, message: e.message, status: e.status || 0 }
    }
  })
)

/** 「访问」：按覆盖 → 影城 accessUrl → 规则入口 的顺序打开，不做抓包等待 */
routers.push(
  new EventRoute('cinemas:entry:open', 'invoke', async (api, data) => {
    const params = data.params || {}
    const rule = api.ctx.extractor.activeRules.find((r) => r.id === String(params.systemCode || ''))
    if (!rule) {
      return { ok: false, message: `系统「${params.systemCode || '未知'}」没有抓包规则，无法打开` }
    }
    try {
      return api.ctx.openEntry(rule, params.cinema || {})
    } catch (e) {
      return { ok: false, message: e.message }
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

/** 采集请求序号：同一时间只服务最后一次点击，旧的循环自己退出 */
let paramCaptureSeq = 0

/** 「获取参数」内嵌页面的独立分区：登录态留着，下次同一系统不用重新登 */
const PARAM_WEB_PARTITION = 'persist:param-web'

/**
 * 给内嵌页面挂上 CDP 抓包。
 *
 * 页面本身直连（走代理这批 H5 根本渲染不出来），参数从调试协议里读响应体。
 * webContentsId 由渲染进程通过 <webview>.getWebContentsId() 传进来。
 */
routers.push(
  new EventRoute('cinemas:attach-capture', 'invoke', async (api, data) => {
    const { ctx } = api
    const id = (data.params || {}).webContentsId
    if (typeof ctx.attachPageCapture !== 'function') {
      return { ok: false, message: '当前版本不支持内嵌抓包' }
    }
    return ctx.attachPageCapture(id)
  })
)

routers.push(
  new EventRoute('cinemas:detach-capture', 'invoke', async (api, data) => {
    const { ctx } = api
    if (typeof ctx.detachPageCapture === 'function') {
      ctx.detachPageCapture((data.params || {}).webContentsId)
    }
    return { ok: true }
  })
)

/**
 * 从入口链接推出要解密的域名。
 *
 * 抓的是「这家影城的这条链接」，所以域名跟着链接走，而不是跟着出票系统走：
 * 同一个系统几十家影城各有一条链接，域名可能完全不同，硬编码规则永远追不上。
 * 同时把主域通配带上 —— 页面在 a.xxx.com，真正的登录接口常常在 b.xxx.com。
 */
export function hostsForEntryUrl(url) {
  let host = ''
  try {
    host = new URL(String(url)).hostname.toLowerCase()
  } catch {
    return []
  }
  if (!host) return []

  const parts = host.split('.')
  // .com.cn / .net.cn 这类二级后缀要取三段才算主域
  const secondLevel = ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'co.uk']
  const tail2 = parts.slice(-2).join('.')
  const base =
    parts.length >= 3 && secondLevel.includes(tail2) ? parts.slice(-3).join('.') : tail2

  return [...new Set([host, `*.${base}`])]
}

/**
 * 参数弹窗的「获取参数」。
 *
 * 一条完整链路是：代理先跑 → 打开这家影城的入口链接（参数窗口的 session 会被拧到本机代理）→
 * 等操作员在里面登录 → 边抓边把值推回弹窗。
 *
 * 域名从链接来：打开的是 CinemaGroup.accessUrl 那条具体链接（带 wid / wapid 之类的参数，
 * 决定进哪家影城），抓包白名单就是这条链接的域名 + 主域通配。
 * 有对应的出票系统规则时顺带用上它的精确路径（能绕开占位值），没有规则也能靠字段名抓。
 *
 * 「边抓边推」是重点：登录要输账号、等短信、过滑块，一次性黑盒等待 20 秒基本必然落空，
 * 操作员也不知道到底在等什么。所以这里改成持续扫描，抓到就推一条
 * `param-capture:update`，弹窗实时填值；窗口被关掉、超时或被新请求取代才收工。
 */
/**
 * 「获取参数」前置：把代理、解密白名单、参数窗口的 session 都准备好。
 *
 * 拆成独立一步是因为页面嵌在弹窗的 <webview> 里：渲染进程要先拿回
 * 「该加载哪条链接、用哪个 partition」才能把页面放进去，
 * 而抓包那一轮要持续几十秒，不能和「准备」挤在同一个请求里。
 */
routers.push(
  new EventRoute('cinemas:prepare-params', 'invoke', async (api, data) => {
    const { ctx } = api
    const cinema = (data.params || {}).cinema || {}
    const entryUrl = String(cinema.accessUrl || '').trim()
    if (!entryUrl) return { ok: false, message: '该影城没有配置入口链接，无法打开' }

    return {
      ok: true,
      url: entryUrl,
      hosts: hostsForEntryUrl(entryUrl),
      partition: PARAM_WEB_PARTITION,
      // 这些 H5 基本只在手机上看过，桌面 UA 会拿到「请在微信中打开」的拦截页；
      // 但也不能带 MicroMessenger —— 带上了页面就去等微信 JSSDK，永远等不到
      userAgent: ctx.mobileUA || ''
    }
  })
)

routers.push(
  new EventRoute('cinemas:capture-params', 'invoke', async (api, data) => {
    const { ctx } = api
    const params = data.params || {}
    const systemCode = String(params.systemCode || '')
    const cinema = params.cinema || {}
    const entryUrl = String(cinema.accessUrl || '').trim()

    // 规则只是加分项：有就用精确路径，没有也不挡路 —— 抓包靠的是链接
    const rule = ctx.extractor.activeRules.find((r) => r.id === systemCode) || null
    const entryHosts = entryUrl ? hostsForEntryUrl(entryUrl) : []

    if (!entryUrl && !rule) {
      return { ok: false, message: '该影城没有配置入口链接，无法确定要打开哪个页面' }
    }

    let keys = Array.isArray(params.keys)
      ? [...new Set(params.keys.filter(Boolean).map(String))]
      : []
    // 后台没配 captureConfig 时退回规则自己声明的字段：
    // 规则最清楚这套系统登录响应里有什么，连规则都没声明才是真的「无参可抓」
    let rows = Array.isArray(params.rows) && params.rows.length ? params.rows : []
    if (!keys.length && rule) {
      rows = describeParams(rule)
      keys = rows.map((item) => item.key)
    }

    // 本次采集用的「有效规则」：有正式规则就用它，没有就按入口链接临时造一条
    const activeRule =
      rule || {
        id: systemCode || '__entry__',
        name: cinema.name || '影城入口链接',
        enabled: true,
        hosts: entryHosts,
        params: keys.map((key) => ({ key })),
        launch: entryUrl ? { type: 'h5', url: entryUrl } : null
      }

    const seq = ++paramCaptureSeq

    // 页面由弹窗里的 <webview> 自己加载（直连），这里不再起代理：
    // 这批 H5 一旦套代理就渲染不出来，抓包改由 CDP 旁听响应体。
    let launch = null
    if (params.launch !== false && typeof ctx.openEntry === 'function') {
      try {
        launch = await ctx.openEntry(activeRule, cinema)
      } catch (e) {
        launch = { ok: false, message: `打开入口失败：${e.message}` }
      }
    }

    const values = {}
    // key → 取值来源（响应体 data.baseTypeRes / 请求头 / 按名匹配…），弹窗里标在值后面
    const from = {}
    // 0 未知 / 1 按名匹配 / 2 规则精确命中
    const rank = {}

    const put = (key, value, desc, level) => {
      if (!value) return
      if ((rank[key] || 0) > level) return
      values[key] = value
      from[key] = desc
      rank[key] = level
    }

    // 声明了 deny 的字段只认精确层：奥斯卡公共请求体里有个 k="123" 的占位值，
    // 按名匹配会稳定抓到它，抓到假值比抓不到更糟
    const strict = new Set(keys.filter((key) => (paramDef(activeRule, key).deny || []).length))

    // 只回扫最近 200 条：更早的基本是别的系统，翻全量没意义还慢
    let scanned = Math.max(0, ctx.captures.length - 200)

    /**
     * 域名判定：正式规则的域名，或者入口链接自己的域名，都算「这一轮该看的」。
     *
     * 为什么还要带上入口域名：影城的入口链接域名和各系统规则里写死的域名经常不一致
     * （同一个出票系统，几十家影城各挂在自己的 H5 域名下），只认规则会把这一轮的
     * 流量全部过滤掉 —— 表现为抓了两分钟什么也没有。
     */
    const entryRule = { hosts: entryHosts }
    const inScope = (host) =>
      ctx.extractor.hostMatches(activeRule, host) ||
      (entryHosts.length ? ctx.extractor.hostMatches(entryRule, host) : false)

    const scanNew = () => {
      const list = ctx.captures
      if (list.length < scanned) scanned = 0 // 缓冲被截断过，从头再扫
      for (let i = scanned; i < list.length; i += 1) {
        const record = list[i]
        if (!inScope(record.host)) continue

        for (const [key, hit] of Object.entries(resolveForKeys(activeRule, record, keys))) {
          put(key, hit.value, hit.from, 2)
        }

        const rest = keys.filter((key) => !strict.has(key) && (rank[key] || 0) < 2)
        if (rest.length) {
          for (const [key, value] of Object.entries(pickValues(record, rest))) {
            put(key, value, '按字段名匹配', 1)
          }
        }
      }
      scanned = list.length
    }

    const snapshot = () => ({
      values: { ...values },
      from: { ...from },
      missing: keys.filter((key) => !values[key])
    })
    /** 每抓到一点就推一次，弹窗不用等整轮结束才看见 */
    const notify = () => {
      if (typeof ctx.sendToRenderer === 'function') {
        ctx.sendToRenderer('param-capture:update', snapshot())
      }
    }

    scanNew()
    notify()

    // 一个字段都没有：窗口已经开着了，让操作员自己登录看页面，不占用等待时间
    if (!keys.length) {
      return {
        ok: true,
        rows,
        values,
        from,
        missing: [],
        launch,
        proxyRunning: ctx.proxyRunning,
        message: '该程序没有声明抓包字段，入口已打开'
      }
    }

    // 后台字段清单里常混着「会员成本」「备注」这种根本不在流量里的字段，
    // 以它们为准会让弹窗每次都干等满超时 —— 等待只盯规则声明过的可抓字段
    const declared = new Set(
      (activeRule.params || []).map((item) =>
        normalizeKey(typeof item === 'string' ? item : item?.key || '')
      )
    )
    const blocking = declared.size ? keys.filter((key) => declared.has(normalizeKey(key))) : keys

    // 登录要时间：默认给 2 分钟，最长 5 分钟；窗口被关掉立刻收工
    const waitMs = Math.min(Math.max(Number(params.waitMs) || 120000, 5000), 300000)
    const deadline = Date.now() + waitMs
    const startedAt = Date.now()
    const h5 = Boolean(launch && launch.ok && launch.mode === 'h5')

    // 收工原因要能说出来：「抓不到」和「你关了窗口」是两件事，混在一起没法排查
    let stopReason = 'timeout'
    while (Date.now() < deadline) {
      // 又点了一次「获取参数」或点了「停止」：这一轮让位，别抢流量
      if (seq !== paramCaptureSeq) {
        stopReason = 'superseded'
        break
      }
      // 操作员把 H5 窗口关了 = 放弃了，别让按钮再转两分钟
      if (h5 && Date.now() - startedAt > 3000 && !ctx.isEntryWindowOpen?.()) {
        stopReason = 'window-closed'
        break
      }
      if (blocking.every((key) => values[key])) {
        stopReason = 'complete'
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 700))
      scanNew()
      notify()
    }

    return {
      ok: true,
      rows,
      ...snapshot(),
      launch,
      proxyRunning: ctx.proxyRunning,
      stopReason,
      timedOut: stopReason === 'timeout'
    }
  })
)

routers.push(
  new EventRoute('cinemas:capture-params:stop', 'invoke', async () => {
    // 序号 +1：正在跑的那一轮下一跳自己 break，已结束的调用不受影响
    paramCaptureSeq += 1
    return { ok: true }
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
      expiry: r.expiry,
      // 入口可以在「影城配置」里改，界面需要看到当前值
      launch: r.launch || null
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
