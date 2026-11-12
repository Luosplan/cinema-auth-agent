import EventRoute from './EventRoute'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import fs from 'node:fs'
import { pickValues, describeTraffic, isPhoneKey } from '../collectors/ParamCollector.js'
import { seedHosts, inFamily, isNoiseHost, registrableOf } from '../collectors/SystemDomains.js'
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
     * 「抓到什么程度算完」的判据只认必填字段。
     *
     * 不能拿全部字段去判：captureConfig 里还有「会员成本 / 备注」这种人工填的字段，
     * 它们永远不会出现在流量里，用全字段当条件就等于「永远抓不齐」，只能干等满 45 秒 ——
     * 这也是之前「抓到了也不自动停」的原因。
     */
    const requiredKeys = Array.isArray(params.requiredKeys)
      ? params.requiredKeys.map(String).filter((key) => keys.includes(key))
      : []
    const required = requiredKeys.length ? requiredKeys : keys

    /**
     * 手机号的兜底：出票账号本身就是登录/会员手机号。
     *
     * 手机号在流量里**只出现在登录那一次请求**的 data 里（凤凰云智叫 loginId）；
     * 已登录态下再刷新页面，浏览器只拿现成 sid 去拉数据，手机号一次都不会再发 ——
     * 这也是「sid/tid 都抓到了、就手机号一直空」的原因。
     * 后台这一栏配的是 `mobile`，恰好等于账号本身，那就不该逼用户退出登录重来。
     *
     * 只认标准 11 位手机号：账号是商户号 / 渠道码这类值时不会误填。
     * 也不参与「什么时候算抓齐」的判定 —— 否则一开始就被补齐，等不到 sid / tid。
     */
    const account = String(params.account || '').trim()
    const phoneFromAccount = []
    if (/^(\+?86)?1[3-9]\d{9}$/.test(account)) {
      for (const key of required) {
        if (isPhoneKey(key)) phoneFromAccount.push(key)
      }
    }
    const mustCapture = required.filter((key) => !phoneFromAccount.includes(key))

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
     * 解密范围：点哪家影城，就只解密它那一族域名。
     *
     * 这几家系统的接口域名是固定的（凤凰云智永远在 yuekeyun.com 上），
     * 所以按 systemCode 取出域名族直接锁定：h5lark / mtop / cdn / h5lark-be 全在族内，
     * alicdn / mmstat / googleapis / h5api.m.taobao.com 这类浏览器的后台流量一律隧道直通 ——
     * 不解密、不抓取、不参与取值。这样线索里只剩有用的域名，也不会把别人的同名 phone 混进来。
     *
     * 没登记过的系统（比如 mini 那套随机域名）退回「本次窗口临时全量解密」，
     * 但在抓到第一个目标字段的那一刻会自动收窄到那一族，见下面的 lockFocus()。
     */
    const rule = ctx.extractor.activeRules.find((r) => r.id === systemCode)
    const ruleHosts = (rule?.hosts || []).map((h) => String(h).replace(/^\*\./, ''))
    const focus = new Set(ruleHosts.length ? ruleHosts : seedHosts(systemCode))
    ctx.focusHosts = focus
    let loose = focus.size === 0
    if (loose) ctx.interceptAll = true

    /** 锁定（或收窄）解密范围。锁定后 matchHost 只对族内域名返回 true */
    const lockFocus = (host) => {
      const family = registrableOf(host)
      if (!family || focus.has(family)) return
      focus.add(family)
      api.log('info', `解密范围锁定 ${[...focus].join('、')}，其余域名不再解密`)
    }

    try {
      const values = {}
      const accept = (record) => {
        if (isNoiseHost(record.host)) return false
        if (focus.size) return inFamily(record.host, focus)
        return Boolean(record.host)
      }
      // 只回扫最近 200 条：更早的基本是别的系统，翻全量没意义还慢
      let scanned = Math.max(0, ctx.captures.length - 200)
      /** 留一份命中的记录用于事后诊断（字段名对不上时靠它说清楚） */
      const accepted = []
      const scanNew = () => {
        const list = ctx.captures
        if (list.length < scanned) scanned = 0 // 缓冲被截断过，从头再扫
        for (let i = scanned; i < list.length; i += 1) {
          const record = list[i]
          if (!accept(record)) continue
          accepted.push(record)
          if (accepted.length > 120) accepted.shift()
          const got = pickValues(record, keys)
          if (!Object.keys(got).length) continue
          Object.assign(values, got)
          /**
           * 兜底模式（这套系统没登记域名族）下抓到第一个目标字段时收窄：
           * 给东西的这一族就是对的，其余域名立刻停止解密。
           */
          if (!focus.size) {
            lockFocus(record.host)
            loose = false
            ctx.interceptAll = false
          }
        }
        scanned = list.length
      }

      scanNew()
      const startedAt = Date.now()
      const waitMs = Math.min(Math.max(Number(params.waitMs) || 20000, 3000), 60000)
      const deadline = startedAt + waitMs
      let stopped = false
      /**
       * 窗口内看住系统代理：Clash 这类工具是随时可能重写配置的（用户去点一下开关就没了），
       * 所以抓包期间每 5 秒回读一次，被改走就抢回来。
       * 最多抢 3 次 —— 跟一个反复争夺的软件死磕没有意义，日志里说明就行。
       */
      let lastSysCheck = Date.now()
      let reasserts = 0
      /**
       * 抓齐之后再收一小会儿：同一批响应里常带着别的字段。
       * 手机号没到手时多等一会儿（6 秒）—— 凤凰云智的手机号在 login2 / getaccountid
       * 这两个接口的响应体里（`data.bizValue.account.mobile`），它们往往比 cookie 晚一拍，
       * 立刻收工就会白白错过，只能退回账号兜底。
       */
      let settleUntil = 0
      let settleMs = 2000
      while (Date.now() < deadline) {
        if (ctx.captureStop) {
          stopped = true
          break
        }
        if (mustCapture.every((key) => values[key])) {
          if (!settleUntil) {
            const needPhone = phoneFromAccount.some((key) => !values[key])
            settleMs = needPhone ? 6000 : 2000
            settleUntil = Date.now() + settleMs
          }
          if (Date.now() >= settleUntil) break
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

      /**
       * 手机号兜底：抓不到就用出票账号填上（上面已确认账号本身就是手机号）。
       * 真抓到了就不覆盖 —— 抓到的永远优先。
       */
      const fromAccount = []
      for (const key of phoneFromAccount) {
        if (!values[key]) {
          values[key] = account
          fromAccount.push(key)
        }
      }
      if (fromAccount.length) api.log('info', `手机号取自出票账号（${account}）`)

      /**
       * `missing` 只算必填：会员成本 / 备注这类人工字段永远抓不到，
       * 把它们算进「还没抓到」会让界面在抓齐成功时也报红。
       */
      const missing = required.filter((key) => !values[key])
      const complete = missing.length === 0

      let reason = ''
      if (missing.length) {
        reason = diagnoseMiss(accepted, focus)
        api.log(
          'warn',
          `抓包未凑齐：缺 ${missing.join('、')}（命中记录 ${accepted.length} 条）` +
            (reason ? `｜${reason}` : '')
        )
        const file = dumpMiss(ctx, systemCode, required, values, accepted)
        if (file) api.log('warn', `抓包诊断已写入 ${file}（需要排查时把这个文件发出来）`)
      } else {
        api.log('info', `必填参数已抓齐（${required.join('、')}），自动停止抓包`)
      }

      return {
        ok: true,
        values,
        missing,
        // 必填全部到手：界面据此提示「已自动停止」，不是超时失败
        complete,
        // 这些字段不是抓到的，是直接用出票账号补的（目前只有手机号）
        fromAccount,
        // 没抓齐时的一句话原因：是没流量、没登录，还是字段名对不上
        reason,
        hints: missing.length ? { ...describeTraffic(accepted), scope: [...focus] } : null,
        // 用户点了「停止」而不是等满窗口：界面提示要说「保留已抓到的」，不算失败
        stopped,
        proxyRunning: ctx.proxyRunning,
        // 本次只解密了哪些域名族 —— 界面上一句话就能说清「在盯谁」
        scope: [...focus],
        // 本次是否用了「全量解密」窗口，界面提示里要说明
        loose
      }
    } finally {
      ctx.captureStop = false
      // 解密范围只在这次窗口内有效：复位后除「设置 → 抓包规则」外一律隧道直通
      ctx.focusHosts = null
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

/**
 * 没抓齐时，判断到底卡在哪一步，只回一句人话。
 *
 * 「没抓到」这三种原因的处理方式完全不同，不区分就只能让用户反复重试：
 *   1. 一条请求都没有 → 页面没刷新，或系统代理没生效；
 *   2. 有请求但没有登录请求 → 用户是在点「获取参数」**之前**登录的，流量早过去了；
 *   3. 有登录请求但字段没对上 → 字段名不同，要靠诊断文件看真实报文。
 */
function diagnoseMiss(accepted, focus) {
  if (!accepted.length) {
    const scope = focus && focus.size ? [...focus].join('、') : ''
    return scope
      ? `本次没有收到 ${scope} 的任何请求：页面可能还没刷新，或系统代理没生效`
      : '本次没有收到任何请求：页面可能还没刷新，或系统代理没生效'
  }
  if (!accepted.some(looksLikeLogin)) {
    return `本次收到 ${accepted.length} 条请求，但里面没有登录请求 —— 请先在浏览器里退出登录，再点登录`
  }
  return `登录请求已经抓到，但这几个字段不在里面（字段名可能不同），诊断文件里有原始报文`
}

/** 表单里的 JSON 是 URL 编码的，判断前先解一层 */
function safeDecode(text) {
  const raw = String(text || '')
  if (!raw.includes('%')) return raw
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 这条记录像不像登录：请求体里出现 loginId / password，或响应里带出真实的 larkSid */
function looksLikeLogin(record) {
  const text = `${safeDecode(record.reqBody)} ${record.resBody || ''}`
  return /loginid|"password"|password=|larksid"\s*:\s*"[^"]{6,}|mobile"\s*:\s*"1\d{10}/i.test(text)
}

function maskSecret(text) {
  return String(text || '')
    .replace(/("?(?:password|pwd|passwd)"?\s*[:=]\s*"?)[^"&,\s]{2,}/gi, '$1***')
    .replace(/(password|pwd)=[^&\s]{2,}/gi, '$1=***')
}

function clip(text, max) {
  const value = String(text || '')
  return value.length > max ? `${value.slice(0, max)}…（共 ${value.length} 字符）` : value
}

function headerNames(headers, name) {
  if (!headers) return ''
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  if (!key) return ''
  const raw = headers[key]
  const list = Array.isArray(raw) ? raw : [String(raw)]
  return list
    .join(';')
    .split(/[;,]/)
    .map((part) => String(part).split('=')[0].trim())
    .filter(Boolean)
    .slice(0, 30)
    .join(',')
}

/**
 * 把本次命中的记录落一份诊断文件。
 *
 * 为什么落到文件而不是弹窗：用户明确不要界面上摆调试信息，
 * 但这几种「抓不到」光看日志真定位不了（字段名、编码层级、请求体形状都要看原文）。
 * 只写本地数据目录，含密码的字段做脱敏。
 */
function dumpMiss(ctx, systemCode, required, values, accepted) {
  try {
    const dir = join(ctx.dataDir, 'diagnostics')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const file = join(dir, `capture-miss-${stamp}.json`)
    const records = (accepted || []).slice(-40).map((r) => ({
      host: r.host,
      method: r.method,
      path: clip(r.path, 300),
      reqBody: clip(maskSecret(r.reqBody), 2000),
      resBody: clip(maskSecret(r.resBody), 2000),
      cookieNames: headerNames(r.reqHeaders, 'cookie'),
      setCookieNames: headerNames(r.resHeaders, 'set-cookie')
    }))
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          systemCode,
          required,
          values,
          recordCount: records.length,
          records
        },
        null,
        2
      )
    )
    return file
  } catch {
    return ''
  }
}

export default routers
