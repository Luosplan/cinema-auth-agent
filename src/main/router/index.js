import EventRoute from './EventRoute'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import fs from 'node:fs'
import { pickValues } from '../collectors/ParamCollector.js'
import { checkCaInstalled, probeCaInstalled } from '../mitm/CaTrust.js'
import { parseProxyServer } from '../mitm/SystemProxy.js'
import {
  buildCinemaTree,
  expandProgramToCinemas,
  accountsOf,
  cinemasOfProgram,
  paramSchemaOf
} from '../api/cinemaMapper.mjs'

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

// 登录：接口地址固定取 config/endpoints.js，用户无需配置
routers.push(
  new EventRoute('auth:login', 'invoke', async (api, data) => {
    const { username, phone, password } = data.params || {}
    try {
      return { ok: true, auth: await api.ctx.auth.signIn({ username, phone, password }) }
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

// 影城账号：数据来自「程序账号配置」接口，一行 = 一个出票程序（含账号与凭证状态）
const CONFIGS_PATH = '/ticket-program-account-configs?includeUnconfigured=1&compact=1'
// 单个程序：加 programId 才会回 config_schema（字段声明），参数弹窗必须走这个
const CONFIG_PATH = '/ticket-program-account-configs?includeUnconfigured=1'
// 影城字典：带专资号 / 城市 / 地址，详情弹窗靠它把影城清单补全
const CINEMAS_PATH = '/cinemas'

routers.push(
  new EventRoute('cinemas:tree', 'invoke', async (api) => {
    try {
      const rows = await api.ctx.auth.get(CONFIGS_PATH)
      const list = Array.isArray(rows) ? rows : []
      // 缓存原始行，cinemas:accounts 直接按 program_id 取，不用重复请求
      api.ctx.serverCinemas = list
      /**
       * children 摊成「一行一个影城」：连锁程序一套账号管多家影城，后台也是逐家列的。
       * 分组上的 programCount 保留程序数（左栏显示的那个数字不变）。
       */
      const tree = buildCinemaTree(list).map((group) => ({
        ...group,
        children: expandProgramToCinemas(group.children)
      }))
      return { ok: true, tree }
    } catch (e) {
      return { ok: false, message: e.message, status: e.status || 0 }
    }
  })
)

// 单个程序的出票账号：从缓存里取，缓存缺失时回源一次（正常路径下树里已带）
routers.push(
  new EventRoute('cinemas:accounts', 'invoke', async (api, data) => {
    const programId = Number((data.params || {}).cinemaGroupId || 0)
    if (!programId) return { ok: false, message: '缺少程序 ID' }
    try {
      let list = api.ctx.serverCinemas
      if (!Array.isArray(list)) {
        const rows = await api.ctx.auth.get(CONFIGS_PATH)
        list = Array.isArray(rows) ? rows : []
        api.ctx.serverCinemas = list
      }
      const row = list.find((item) => Number(item.program_id) === programId)
      if (!row) return { ok: false, message: '未找到该程序' }
      return { ok: true, lists: accountsOf(row) }
    } catch (e) {
      return { ok: false, message: e.message, status: e.status || 0 }
    }
  })
)

/**
 * 参数弹窗：单个程序的抓包参数（字段声明 + 服务端已存的值）。
 *
 * 必须按 programId 单查：列表接口带的是 compact=1，只有值没有 `config_schema`，
 * 靠凭证键名反推会得到 phone / mobile / mobileNumber 一堆同义字段，
 * 真正要抓的 appletToken 反而看不出是必填（重明鸟3.0 就是这种情况）。
 */
routers.push(
  new EventRoute('cinemas:param', 'invoke', async (api, data) => {
    const programId = Number((data.params || {}).programId || 0)
    if (!programId) return { ok: false, message: '缺少程序 ID' }
    try {
      const rows = await api.ctx.auth.get(`${CONFIG_PATH}&programId=${programId}`)
      const list = Array.isArray(rows) ? rows : []
      // 一个程序可能配了多个出票账号（接口按账号一行返回）：全带回去给界面切换
      const matched = list.filter((item) => Number(item.program_id) === programId)
      const use = matched.length ? matched : list
      if (!use.length) return { ok: false, message: '未找到该程序' }
      return { ok: true, ...paramSchemaOf(use) }
    } catch (e) {
      return { ok: false, message: e.message, status: e.status || 0 }
    }
  })
)

/**
 * 影城字典只拉一次：详情弹窗点十次不该打十次接口。
 * `/cinemas` 是**当前账号可见**的影城（164 条），程序可能覆盖到账号外的影城 ——
 * 那些行在详情里保留影城名，专资号 / 地址显示「—」，不做跨账号猜。
 */
async function cinemaRegistry(api) {
  if (!api.ctx.cinemaRegistry) {
    const rows = await api.ctx.auth.get(CINEMAS_PATH)
    const byId = new Map()
    const byName = new Map()
    for (const item of Array.isArray(rows) ? rows : []) {
      byId.set(Number(item.id), item)
      if (item.name) byName.set(item.name, item)
    }
    api.ctx.cinemaRegistry = { byId, byName }
  }
  return api.ctx.cinemaRegistry
}

// 详情弹窗：程序覆盖的影城清单（影城名称 / 专资号 / 城市 / 地址）
routers.push(
  new EventRoute('cinemas:detail', 'invoke', async (api, data) => {
    const programId = Number((data.params || {}).programId || 0)
    if (!programId) return { ok: false, message: '缺少程序 ID' }
    try {
      let list = api.ctx.serverCinemas
      if (!Array.isArray(list)) {
        const rows = await api.ctx.auth.get(CONFIGS_PATH)
        list = Array.isArray(rows) ? rows : []
        api.ctx.serverCinemas = list
      }
      const row = list.find((item) => Number(item.program_id) === programId)
      if (!row) return { ok: false, message: '未找到该程序' }
      const registry = await cinemaRegistry(api)
      return { ok: true, cinemas: cinemasOfProgram(row, registry) }
    } catch (e) {
      return { ok: false, message: e.message, status: e.status || 0 }
    }
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
    if (!keys.length) return { ok: false, message: '该程序没有配置抓包参数' }

    /**
     * 手动停止标志：一开始就同步清零。
     *
     * 必须放在第一个 await 之前 —— 界面上点完「获取参数」按钮就立刻能点「停止」，
     * 而下面光证书校验就要几百毫秒。要是等校验完再清零，用户在那一瞬间点的停止
     * 就会被这里覆盖掉，界面显示已停止、主进程还在傻等满 45 秒。
     * 放在同步段里，后到的 stop 消息一定能被循环看到。
     */
    ctx.captureStop = false

    /**
     * 证书是硬前提：没装根证书时浏览器根本不会跟代理握手成功，
     * 干等满一轮也只会拿到 0 个值 —— 先在这里拦掉并说清楚要做什么。
     */
    const caOk = await checkCaInstalled(ctx.ca.getFingerprint())
    if (!caOk) {
      return {
        ok: false,
        needCa: true,
        message:
          '根证书还没安装，HTTPS 解不开，抓不到任何请求。' +
          '请先点底部「证书 未安装」完成安装，再回来点「获取参数」'
      }
    }

    if (!ctx.proxyRunning) {
      try {
        const started = await ctx.startProxy()
        /**
         * startProxy 被证书闸拦下时是 **return 而不是 throw**，这里必须看返回值：
         * 不然代理没起来、系统代理没设，下面的循环照样等满 45 秒，最后回 0 个值，
         * 用户只会以为「抓包功能坏了」。
         */
        if (!ctx.proxyRunning) {
          return { ok: false, message: started?.error || '抓包代理没能启动，请重试' }
        }
      } catch (e) {
        return { ok: false, message: `抓包代理启动失败：${e.message}` }
      }
    }

    /**
     * 系统代理有没有被别人抢走。
     *
     * 现实里最常见的就是 Clash / V2Ray 开着「系统代理」：它会把注册表整份重写成自己的地址
     * （例如 127.0.0.1:7897），采集助手的 9090 还在跑，但浏览器一条流量都不经过它 ——
     * 表现就是「点了获取参数，等了半天一个值都没抓到」。
     * 这里先抢一次回来，抢不回来就立刻失败并说清楚，别让人白等 45 秒。
     */
    const port = ctx.proxy.port
    let sys = await ctx.systemProxy.verify(port).catch(() => ({ ok: true }))
    // 回读失败（PowerShell 抖动）不能当成「被抢走」，否则会误报把人劝退
    if (sys.error) sys = { ok: true }
    if (!sys.ok) {
      await ctx.systemProxy.reapply(port).catch(() => {})
      sys = await ctx.systemProxy.verify(port)
      if (!sys.ok) {
        const actual = sys.actual || '（未设置）'
        return {
          ok: false,
          hijacked: true,
          message:
            `系统代理当前指向 ${actual}，不是采集助手（127.0.0.1:${port}），` +
            '浏览器流量没经过这里，所以抓不到任何内容。' +
            '本程序已经把原来的代理挂成上游（出网不受影响），但系统代理被它改了回去；' +
            '请在那类软件里关掉「系统代理」开关（软件本身可以继续开着），再点「获取参数」'
        }
      }
    }

    /**
     * 解密范围：`设置 → 抓包规则` 里给这套系统配过域名就只解密那几个域名；
     * 没配过（默认就是没配）就在这次抓包期间**临时放行全部 HTTPS**，抓完立刻恢复。
     * 不放行的话流量全是隧道直通，这里永远拿不到请求头 / 响应体。
     */
    const rule = ctx.extractor.activeRules.find((r) => r.id === systemCode)
    const hasHosts = Boolean(rule && (rule.hosts || []).length)
    const loose = !hasHosts
    if (loose) ctx.interceptAll = true

    try {
      const values = {}
      const accept = (record) =>
        hasHosts ? ctx.extractor.hostMatches(rule, record.host) : Boolean(record.host)
      // 只回扫最近 200 条：更早的基本是别的系统，翻全量没意义还慢
      let scanned = Math.max(0, ctx.captures.length - 200)
      const scanNew = () => {
        const list = ctx.captures
        if (list.length < scanned) scanned = 0 // 缓冲被截断过，从头再扫
        for (let i = scanned; i < list.length; i += 1) {
          const record = list[i]
          if (accept(record)) Object.assign(values, pickValues(record, keys))
        }
        scanned = list.length
      }

      scanNew()
      const waitMs = Math.min(Math.max(Number(params.waitMs) || 20000, 3000), 60000)
      const deadline = Date.now() + waitMs
      let stopped = false
      /**
       * 窗口内看住系统代理：Clash 这类工具是随时可能重写配置的（用户去点一下开关就没了），
       * 所以抓包期间每 5 秒回读一次，被改走就抢回来。
       * 最多抢 3 次 —— 跟一个反复争夺的软件死磕没有意义，日志里说明就行。
       */
      let lastSysCheck = Date.now()
      let reasserts = 0
      while (keys.some((key) => !values[key]) && Date.now() < deadline) {
        if (ctx.captureStop) {
          stopped = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 700))
        scanNew()

        if (Date.now() - lastSysCheck >= 5000) {
          lastSysCheck = Date.now()
          const now = await ctx.systemProxy.verify(port).catch(() => ({ ok: true }))
          if (!now.ok && !now.error && reasserts < 3) {
            reasserts += 1
            /**
             * 中途才打开 VPN 的情况：原来直连出网，用户为了上外网把 Clash 的系统代理打开了。
             * 这时把它的地址接成上游，再把系统代理抢回 9090 —— 否则我们变成直连出网，
             * 外网全断，用户只会以为「开了抓包就上不了网」。
             */
            if (!ctx.proxy.upstream) {
              const adopted = parseProxyServer(now.actual)
              const isSelf = adopted && adopted.port === port && adopted.host === '127.0.0.1'
              if (adopted && !isSelf) {
                ctx.proxy.setUpstream(adopted)
                api.log('info', `检测到系统代理 ${adopted.host}:${adopted.port}，已接为上游`)
              }
            }
            await ctx.systemProxy.reapply(port).catch(() => {})
            api.log('warn', `系统代理被改回 ${now.actual || '空'}，已重新接管（第 ${reasserts} 次）`)
          }
        }
      }
      // 停止或超时前最后扫一遍：跳出循环到返回之间可能刚好有新流量进来
      scanNew()

      return {
        ok: true,
        values,
        missing: keys.filter((key) => !values[key]),
        // 用户点了「停止」而不是等满窗口：界面提示要说「保留已抓到的」，不算失败
        stopped,
        proxyRunning: ctx.proxyRunning,
        // 本次是否用了「全量解密」窗口，界面提示里要说明
        loose
      }
    } finally {
      ctx.captureStop = false
      if (loose) ctx.interceptAll = false
    }
  })
)

/**
 * 提前结束正在进行的抓包。
 * 只是置标志，真正的收尾（返回已抓到的值、恢复解密范围）在 capture-params 的 finally 里做 ——
 * 两边都去动 interceptAll / 代理状态会互相打脸。
 */
routers.push(
  new EventRoute('cinemas:capture-stop', 'invoke', async (api) => {
    api.ctx.captureStop = true
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
      // 界面要能看出「出网是经谁转发的」，否则抓不到包时无从判断
      upstream: ctx.proxy.upstream,
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
    // 抓包规则已移除，这里不再需要把配置回灌给 Extractor
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
    const probe = await probeCaInstalled(ctx.ca.getFingerprint())
    const installed = probe === 'yes'

    /**
     * 证书没了但采集还开着 —— 典型场景是用户绕开本程序，直接去 certmgr 里把证书删了。
     * 代理此时给每个 HTTPS 签一张没人信任的证书，界面还亮着「采集中」，
     * 却一条内容都解不出来，还会连带把客户机正在用的小程序搞报错。
     * 这里就地停掉，界面下一轮轮询（或这次返回的 stopped）即可反映真实状态。
     *
     * 只在探到明确的 'no' 时动手：'unknown'（PowerShell 抖动 / 超时）不能当「证书被删」，
     * 否则会平白停掉正在跑的采集。
     */
    let stopped = false
    if (probe === 'no' && ctx.proxyRunning) {
      try {
        await api.stopProxy()
        stopped = true
      } catch {
        /* 停失败不改结论：证书确实已经没了，这个事实优先 */
      }
    }

    return {
      fingerprint: ctx.ca.getFingerprint(),
      notAfter: ctx.ca.caCert?.validity?.notAfter || null,
      installed,
      stopped
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
    const fingerprint = api.ctx.ca.getFingerprint()
    const thumb = fingerprint.replace(/:/g, '')

    /**
     * 不能用 PowerShell 的 Remove-Item。
     *
     * 用户根存储被系统保护，对 `Cert:\CurrentUser\Root` 的删除会直接抛
     * 「不允许对用户根存储和 UI 执行操作」，而脚本末尾照样输出 'ok' ——
     * 结果是界面提示卸载成功、证书还稳稳躺在受信任根里（这就是「卸载没效果」的原因）。
     * certutil -user 走 CryptoAPI，删当前用户的根证书不需要管理员权限。
     */
    try {
      await exec('certutil', ['-user', '-delstore', 'Root', thumb], {
        windowsHide: true,
        timeout: 30000
      })
    } catch {
      // 证书本来就不在时 certutil 返回非 0，不算失败，交给下面统一复核
    }

    const installed = await checkCaInstalled(fingerprint)
    if (installed) {
      return { ok: false, message: '卸载未生效，证书仍在受信任的根证书颁发机构里' }
    }

    /**
     * 证书没了，采集必须一起停：代理还在跑的话所有 HTTPS 都被签一张没人信任的证书，
     * 界面显示「采集中」却一条 token 也解不出来，还会把正在用的小程序搞报错。
     */
    let stopped = false
    if (api.ctx.proxyRunning) {
      try {
        await api.stopProxy()
        stopped = true
      } catch {
        /* 停失败也还是要把「证书已卸载」这个事实告诉界面 */
      }
    }

    return {
      ok: true,
      stopped,
      message: stopped ? '证书已卸载，采集已停止' : '证书已卸载'
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
 * 窗口控制。
 *
 * `frame: false` 之后系统不再画 ─ □ ✕，只能由渲染层自绘标题栏调用这几个路由。
 * 最大化状态额外通过 `window-state` 广播推给渲染层，让「还原」图标能跟着变。
 */
routers.push(
  new EventRoute('window:minimize', 'invoke', async (api) => {
    const win = api.getWin()
    if (win) win.minimize()
    return { ok: Boolean(win) }
  })
)

routers.push(
  new EventRoute('window:toggle-max', 'invoke', async (api) => {
    const win = api.getWin()
    if (!win) return { ok: false, maximized: false }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { ok: true, maximized: win.isMaximized() }
  })
)

routers.push(
  new EventRoute('window:close', 'invoke', async (api) => {
    const win = api.getWin()
    if (win) win.close()
    return { ok: Boolean(win) }
  })
)

routers.push(
  new EventRoute('window:state', 'invoke', async (api) => {
    const win = api.getWin()
    return { maximized: Boolean(win && win.isMaximized()) }
  })
)

export default routers
