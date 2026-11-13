import EventRoute from './EventRoute'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import net from 'node:net'
import fs from 'node:fs'
import { pickValues, describeTraffic, isPhoneKey, fieldsNeverSeen } from '../collectors/ParamCollector.js'
import { decideEarlyExit } from '../collectors/IdleGuard.js'
import {
  seedHosts,
  inFamily,
  isNoiseHost,
  registrableOf,
  pathHintsOf,
  pathMatchesSystem,
  isLooseSystem
} from '../collectors/SystemDomains.js'
import { checkCaInstalled, probeCaInstalled, invalidateCaCache } from '../mitm/CaTrust.js'
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

/**
 * 探一下代理端口是不是真在监听。
 *
 * `ctx.proxyRunning` 只是个内存标志 —— 代理进程内部出错、端口被别的程序占了，
 * 标志照样是 true，面板就会一直显示「抓包中」而连接数永远是 0。
 * 真连一次 localhost 才能确定「浏览器能不能连上来」。
 *
 * 面板 800ms 轮询一次，端口不通时每次都要白等满超时，所以结果缓存 1.5 秒：
 * 探测精度对这个场景足够，又不至于让主进程一直被 pending 的连接占着。
 */
const portProbeCache = new Map()
function probePort(port, timeout = 350) {
  if (!port) return Promise.resolve(false)
  const cached = portProbeCache.get(port)
  if (cached && Date.now() - cached.at < 1500) return Promise.resolve(cached.ok)
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => {
      socket.removeAllListeners()
      socket.destroy()
      portProbeCache.set(port, { ok, at: Date.now() })
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
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
    /**
     * 参数可能是空的 —— 没有可抓字段就直接告诉界面「没有」，不要起代理干等。
     *
     * 后台有些程序的配置项全是人工填写项（备注 / 会员成本 / 折扣），
     * 这些永远不会出现在流量里，开了抓包窗口也只能等到超时，
     * 用户体感就是「一直在获取，最后什么都没有」。
     */
    if (!keys.length) {
      return {
        ok: true,
        values: {},
        missing: [],
        empty: true,
        complete: false,
        stopped: false,
        reason: '该程序没有配置抓包参数，不需要抓'
      }
    }
    if (!keys.some((key) => !isManualField(key))) {
      return {
        ok: true,
        values: {},
        missing: [],
        empty: true,
        complete: false,
        stopped: false,
        reason: '该程序的参数都是人工填写项（备注 / 成本 / 折扣），流量里抓不到，直接手填'
      }
    }

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
    /**
     * 必填标记缺失（老数据没写 required）时才退回全部字段，
     * 但要把「人工填」的那几列排掉 —— 备注 / 会员折扣这类永远不会出现在流量里，
     * 拿它们当「抓齐」条件就等于永远等不满 45 秒。
     */
    const required = requiredKeys.length ? requiredKeys : keys.filter((key) => !isManualField(key))

    /**
     * 手机号单独一档：它和别的字段不是一个来源。
     *
     * 凤凰云智的 mobile 只在 **响应体**里（getaccountid / getsidbytid 的
     * `data.bizValue.account.mobile`），而 tid / larkSid / _m_h5_tk 在请求体与 cookie 里。
     * 所以响应体一旦解不开（比如服务端回了我们解不了的压缩），就会出现
     * 「四个字段都有、就手机号永远空」——这也是之前一直以为是「只在登录请求里出现」的原因。
     *
     * 现在的策略：其它必填齐了之后，再给手机号 2.5 秒（响应体通常比 cookie 晚一拍），
     * 超时就用已抓到的收工 —— 既不会为它干等 45 秒，也不会因为提前收尾漏掉它。
     *
     * 另外**不再拿出票账号兜底**：那个账号来自后台接口，跟浏览器里登录的往往不是同一个号。
     */
    const phoneKeys = new Set(required.filter(isPhoneKey))
    const restKeys = required.filter((key) => !phoneKeys.has(key))

    /**
     * 手动停止标志：一开始就同步清零。
     *
     * 必须放在第一个 await 之前 —— 界面上点完「获取参数」按钮就立刻能点「停止」，
     * 而下面光证书校验就要几百毫秒。要是等校验完再清零，用户在那一瞬间点的停止
     * 就会被这里覆盖掉，界面显示已停止、主进程还在傻等满 45 秒。
     * 放在同步段里，后到的 stop 消息一定能被循环看到。
     */
    ctx.captureStop = false
    // 上一轮的被筛记录 / 计数不能混进这一轮的面板
    if (Array.isArray(ctx.skippedCaptures)) ctx.skippedCaptures.length = 0
    if (ctx.proxy?.stats) ctx.proxy.stats.skipped = 0

    /**
     * 证书是硬前提：没装根证书时浏览器根本不会跟代理握手成功，
     * 干等满一轮也只会拿到 0 个值 —— 先在这里拦掉并说清楚要做什么。
     *
     * 但只在**这一轮真要启代理**时查：代理已经在跑，说明启动那会儿已经过了闸，
     * 中途被删证书由 ca:info 那一路负责停掉采集。
     * 每点一次「获取参数」都起一个 PowerShell 查证书存储，光这一步就白等半秒到两秒。
     */
    let startedHere = false
    if (!ctx.proxyRunning) {
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
        startedHere = true
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
    /** 留给循环第一拍消费的系统代理回读（代理本来就在跑时用，见下面的 else 分支） */
    let pendingSysCheck = null
    if (startedHere) {
      /** 刚接管过系统代理，必须当场确认：抢不回来就立刻失败，别让人白等 45 秒 */
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
    } else {
      /**
       * 代理本来就跑着（常规路径）：这一拍不阻塞。
       * 回读一次注册表要起一个 PowerShell（几百毫秒起），挪到等待循环第一拍去消费，
       * 用户少等的这几百毫秒，就是「刷一下页面就出参数」和「点了按钮没反应」的差别。
       */
      pendingSysCheck = ctx.systemProxy.verify(port).catch(() => ({ ok: true, error: 'skip' }))
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
    /**
     * 记下这次用的是哪个系统代号：面板要显示出来。
     * 代号一旦和 SEEDS 里的 key 对不上，解密范围就是空的（表现为「N 条连接 0 解密」），
     * 而用户从界面上看不出代号错在哪 —— 把原始代号亮出来，一眼就能发现是不是它的问题。
     */
    ctx.captureSystemCode = systemCode
    /**
     * 需要放开全量解密的两种情况，理由不一样：
     *   1) `focus.size === 0`：这套系统压根没登记域名族，只能先全量，抓到再收窄；
     *   2) `isLooseSystem`：域名族登记了也认不全（mini 每家影院一个独立域名），
     *      只锁已知族会漏掉别家影城 —— 只能全量解密，靠路径特征（/MiniTicket/）认人。
     * 第 2 种情况 `focus` 是非空的，所以不能再用 `focus.size === 0` 当 loose 的判定。
     */
    const looseByPath = isLooseSystem(systemCode)
    let loose = focus.size === 0 || looseByPath
    if (loose) {
      ctx.interceptAll = true
      /**
       * 全量解密要在日志里说清楚，用户看到「怎么变慢了」时能对上原因，
       * 也知道抓到第一个参数后会自动收窄到那一族。
       */
      api.log(
        'warn',
        looseByPath
          ? `${systemCode} 的域名不固定（各影院独立域名），本次放开全量解密，` +
              `路径命中 ${pathHintsOf(systemCode).join('、')} 就收窄`
          : `未登记 ${systemCode || '该系统'} 的解密域名，本次临时全量解密（已过滤图片等静态资源），` +
              '抓到第一个参数后自动收窄'
      )
    }

    /** 锁定（或收窄）解密范围。锁定后 matchHost 只对族内域名返回 true */
    const lockFocus = (host) => {
      const family = registrableOf(host)
      if (!family || focus.has(family)) return
      focus.add(family)
      api.log('info', `解密范围锁定 ${[...focus].join('、')}，其余域名不再解密`)
    }

    try {
      /**
       * 窗口内把原始记录的节流压到 60ms，并先把积压的那批冲进缓冲。
       * 否则用户刷完页面，值其实已经到了 pending 里，却要再等一拍 400ms 才被回扫看到。
       */
      ctx.captureFastFlush = true
      if (typeof ctx.flushCaptures === 'function') ctx.flushCaptures()

      const values = {}
      const accept = (record) => {
        if (isNoiseHost(record.host)) return false
        if (!focus.size) return Boolean(record.host)
        if (inFamily(record.host, focus)) return true
        /**
         * 域名不在族里，但路径带这套系统的特征（mini 的 /MiniTicket/index.php）：
         * 换了一家影城、域名没登记过，照样认它是目标请求。
         */
        return pathMatchesSystem(systemCode, record.path)
      }
      // 只回扫最近 200 条：更早的基本是别的系统，翻全量没意义还慢
      let scanned = Math.max(0, ctx.captures.length - 200)
      /** 窗口开始时的缓冲长度：之后的记录才算「这次刷新带来的新流量」 */
      const baseline = ctx.captures.length
      /** 这次窗口内有没有真的抓到过新值（只有旧记录凑齐时不能马上交差） */
      let freshHit = false
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
          if (i >= baseline) freshHit = true
          /**
           * 全量解密模式下抓到第一个目标字段就收窄：给东西的这一族就是对的，
           * 其余域名立刻停止解密。
           *
           * 判据用 `loose` 而不是 `!focus.size`：mini 既有已知族（xcxyyww.cn）又要全量，
           * 换了一家影城时命中的域名并不在族里，靠 `lockFocus` 把实际域名并进来。
           */
          if (loose) {
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
       * 「这次确实抓不到」要早点收尾，别让人对着按钮干等满一轮。
       * 判据与阈值都在 IdleGuard 里（no-traffic / no-match / stuck），
       * 核心是「流量有没有进来、进来的是不是目标」，不是「等了多久」。
       */
      const interceptedAtStart = Number(ctx.proxy?.stats?.intercepted) || 0
      const trafficAtStart = Number(ctx.proxy?.stats?.total) || 0
      /** 提前收尾的原因；空串表示正常走完（凑齐或到点） */
      let earlyExit = ''
      /**
       * 窗口内看住系统代理：Clash 这类工具是随时可能重写配置的（用户去点一下开关就没了），
       * 所以抓包期间每 5 秒回读一次，被改走就抢回来。
       * 最多抢 3 次 —— 跟一个反复争夺的软件死磕没有意义，日志里说明就行。
       */
      let lastSysCheck = Date.now()
      let reasserts = 0
      /**
       * 抓齐之后再收一小会儿：同一批响应里常带着别的字段。
       *
       * 600ms 是「这次刷新的流量已经抓到了」的情形 —— 原来在手机号没到手时硬等 6 秒，
       * 而手机号卡住的真实原因是字段名对不上（后台 phone / 流量 mobile），不是「来得晚」，
       * 等多久都不会出现。
       * 1500ms 是「只靠窗口开始前的旧记录就凑齐了」的情形：那批 sid / tid 可能是上一次
       * 会话的，多给一点时间让这次刷新带来的新值把它们替换掉，别把过期值当结果交出去。
       */
      const SETTLE_FRESH_MS = 600
      const SETTLE_STALE_MS = 1500
      /** 其它必填都齐了之后，单独等手机号的宽限 */
      const PHONE_GRACE_MS = 2500
      let settleUntil = 0
      let phoneGraceUntil = 0
      while (Date.now() < deadline) {
        if (ctx.captureStop) {
          stopped = true
          break
        }
        /** 第一拍消费掉「代理本来就在跑」那次后台回读，不阻塞点击到开始抓包的这段 */
        if (pendingSysCheck) {
          const now = await pendingSysCheck
          pendingSysCheck = null
          if (!now.ok && !now.error && reasserts < 3) {
            reasserts += 1
            await ctx.systemProxy.reapply(port).catch(() => {})
            lastSysCheck = Date.now()
            api.log('warn', `系统代理被改回 ${now.actual || '空'}，已重新接管`)
          }
        }
        const restReady = restKeys.every((key) => values[key])
        const phoneReady = [...phoneKeys].every((key) => values[key])
        if (restReady && phoneReady) {
          if (!settleUntil) {
            settleUntil = Date.now() + (freshHit ? SETTLE_FRESH_MS : SETTLE_STALE_MS)
          }
          if (Date.now() >= settleUntil) break
        } else if (restReady) {
          /**
           * 只差手机号：它在响应体里，比 cookie / 请求体晚到一点点。
           * 给它 2.5 秒，抓不到就带着其它字段收工（界面会单独提示手机号没抓到）。
           */
          if (!phoneGraceUntil) phoneGraceUntil = Date.now() + PHONE_GRACE_MS
          if (Date.now() >= phoneGraceUntil) break
        }
        // 250ms 一拍：用户刷完页面 1 秒内就该看到结果，别让人盯着空白等了
        await new Promise((resolve) => setTimeout(resolve, 250))
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
            api.log(
              'warn',
              `系统代理被改回 ${now.actual || '空'}，已重新接管（第 ${reasserts} 次）`
            )
          }
        }

        /**
         * 提前收尾：三种「再等也不会变」的情形（判据见 IdleGuard）。
         * 只在还没抓到任何值时才考虑 —— 已经填了几栏的，交给 settle / phoneGrace 正常收工。
         */
        if (!stopped && !Object.keys(values).length) {
          const traffic = (Number(ctx.proxy?.stats?.total) || 0) - trafficAtStart
          const intercepted = (Number(ctx.proxy?.stats?.intercepted) || 0) - interceptedAtStart
          const verdict = decideEarlyExit({
            waitedMs: Date.now() - startedAt,
            intercepted,
            traffic,
            acceptedCount: accepted.length,
            gotCount: 0,
            // 全量解密时解密条数不代表「目标系统来流量了」，no-match 要跳过（同 IdleGuard 注释）
            loose
          })
          if (verdict) {
            earlyExit = verdict
            api.log(
              'warn',
              `提前收尾（${verdict}）：本轮 ${traffic} 条连接 / 解密 ${intercepted} 条 / ` +
                `命中目标请求 ${accepted.length} 条，一个参数都没取到`
            )
            break
          }
        }
      }
      // 停止或超时前最后扫一遍：跳出循环到返回之间可能刚好有新流量进来
      scanNew()

      /**
       * `missing` 只算必填：会员成本 / 备注这类人工字段永远抓不到，
       * 把它们算进「还没抓到」会让界面在抓齐成功时也报红。
       */
      const missing = required.filter((key) => !values[key])
      /**
       * 手机号单独归类：
       *   - phoneMissing：只在响应体里出现的手机号没抓到 —— 界面提示话术不一样；
       *   - realMissing：其它必填缺项 —— 这才说明「字段名对不上 / 没流量」，要写诊断文件。
       * 「抓齐」的口径是**全部必填（含手机号）**，不再把手机号当成永远抓不到的那一栏。
       */
      const phoneMissing = missing.filter((key) => phoneKeys.has(key))
      const realMissing = missing.filter((key) => !phoneKeys.has(key))
      const complete = required.length > 0 && missing.length === 0

      let reason = ''
      if (realMissing.length && !earlyExit) {
        reason = diagnoseMiss(accepted, focus, realMissing)
        api.log(
          'warn',
          `抓包未凑齐：缺 ${realMissing.join('、')}（命中记录 ${accepted.length} 条）` +
            (reason ? `｜${reason}` : '')
        )
        const file = dumpMiss(ctx, systemCode, required, values, accepted)
        if (file) api.log('warn', `抓包诊断已写入 ${file}（需要排查时把这个文件发出来）`)
      } else if (realMissing.length && earlyExit) {
        /**
         * 提前收尾时不写诊断文件：这三种情况的原因已经确定（没流量 / 流量不匹配 / 字段名不对），
         * 抱着诊断文件去猜反而更慢。话术要给出下一步动作。
         */
        const scopeText = [...focus].join('、') || '未锁定'
        if (earlyExit === 'no-traffic') {
          reason =
            '这段时间没有任何连接经过代理，所以没有参数。' +
            '先确认刷新页面时走的是本机代理（面板上看「连接」这一行），再点一次获取参数'
        } else if (earlyExit === 'no-match') {
          reason =
            `解密了几十条流量，但没有一条落在 ${scopeText} 上。` +
            '展开面板「直通域名」看目标系统的域名在不在里面；在的话把它发我，我加进域名表'
        } else {
          reason =
            `目标请求抓到了，但 ${realMissing.join('、')} 始终没出现 —— ` +
            '多半是接口里的字段名和配置对不上，把面板里那条命中请求的响应原文发我'
        }
      } else if (phoneMissing.length) {
        api.log(
          'warn',
          `除手机号外已抓齐（${phoneMissing.join('、')} 只在 getaccountid 这类响应体里），` +
            '自动停止抓包；若反复抓不到，多半是响应体没解开'
        )
      } else {
        api.log('info', `必填参数已抓齐（${required.join('、')}），自动停止抓包`)
      }

      return {
        ok: true,
        values,
        missing,
        // 必填全部到手（含手机号）：界面据此提示「已自动停止」，不是超时失败
        complete,
        // 手机号单独回给界面：它只在响应体里，缺了要提示「刷新页面再抓一次」
        phoneMissing,
        // 没抓齐时的一句话原因：是没流量、没登录，还是字段名对不上
        reason,
        /**
         * 一个值都没抓到。
         *
         * 界面上要当「这套系统这次没有参数」处理，不要报成错误 ——
         * 有的程序本来就没有可抓的东西，空就是正常结果。
         */
        empty: !Object.keys(values).length,
        // 提前收尾的原因（no-traffic / no-match / stuck），空串表示正常走完
        earlyExit,
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
      ctx.captureFastFlush = false
      /**
       * 解密范围**不能**在这里清空。
       *
       * 窗口结束后代理还在跑、系统代理仍然指向本机，此时把 focusHosts 置空，
       * 之后每一次刷新都会隧道直通：面板上表现为「190 条连接 · 0 解密 · 解密范围 -」，
       * 用户看到的结论就是「抓包坏了」，其实只是窗口关早了。
       * 真正需要复位的是「全量解密」——那个才是拖慢页面、混进无关凭证的元凶。
       *
       * 所以：锁定过域名族就保留，让窗口外的刷新继续被解密、继续进面板；
       * 没锁定过（未登记系统）关掉全量解密，避免采集结束后还在解全站 HTTPS。
       * 彻底复位放在 stopProxy()。
       */
      if (focus.size) {
        ctx.focusHosts = focus
      } else {
        ctx.focusHosts = null
      }
      /**
       * 全量解密只在窗口内有效，窗口一关必须复位。
       *
       * 这一行原来写在 else 分支里，靠「loose 只可能在 focus 为空时成立」这个巧合才没出事。
       * mini 这类「有已知族、但域名不固定」的系统让 focus 非空与 loose 同时成立，
       * 漏掉它就会在采集结束、窗口关掉之后继续解全站 HTTPS。
       */
      ctx.interceptAll = false
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
    // fresh：状态栏要的是眼下的事实，不能拿 30 秒内的缓存糊过去
    const probe = await probeCaInstalled(ctx.ca.getFingerprint(), { fresh: true })
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
      // 刚装完必须真查一遍，不能沿用安装前的缓存结论
      invalidateCaCache()
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

    invalidateCaCache()
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

/**
 * 抓包面板的数据源：最近 N 条请求 + 每条记录按当前字段清单解析出来的值。
 *
 * 为什么解析放主进程：pickValues 要翻 cookie / 请求头 / 请求体 / 响应体四层，
 * 渲染层拿到的记录里没有 body（体积太大不该走 IPC）。这里一次性算完，
 * 顺便把「合并结果」也拼好，界面只管画。
 *
 * `skipped` 是本次会话被过滤掉的请求数（图片 / 字体 / OPTIONS / 页面 HTML）。
 * 抓不到参数时它是最快的定位线索：skipped 很大而 total 是 0，说明过滤把自己人筛了；
 * 两个都是 0，说明根本没有流量经过代理。
 */
routers.push(
  new EventRoute('captures:inspect', 'invoke', async (api, data) => {
    const { ctx } = api
    const params = data.params || {}
    const keys = Array.isArray(params.keys) ? params.keys.filter(Boolean).map(String) : []
    const limit = Math.min(Math.max(Number(params.limit) || 60, 1), 200)
    const list = ctx.captures.slice(-limit)

    /**
     * 全量解密期间（mini 这类域名不固定的系统）缓冲里混着同一轮的其它接口：
     * 它们的 token / mobile 同名字段会被合并进来，表现成「填了但不是这台影城的」。
     * 所以合并只认「域名族内 或 路径命中系统特征」的记录；面板列表仍显示全部，
     * 找不到目标域名时还能靠它看出实际打的是哪个域名。
     */
    const scopedCode = ctx.captureSystemCode || ''
    const looseSystem = isLooseSystem(scopedCode)
    const inScope = (record) => {
      if (!looseSystem) return true
      if (ctx.focusHosts && ctx.focusHosts.size && inFamily(record.host, ctx.focusHosts)) return true
      return pathMatchesSystem(scopedCode, record.path)
    }

    // 按时间从旧到新合并：后抓到的覆盖先抓到的，跟「获取参数」的口径一致
    const merged = {}
    const records = list.map((record) => {
      const got = pickValues(record, keys)
      if (inScope(record)) Object.assign(merged, got)
      return {
        id: record.id,
        at: record.at,
        method: record.method,
        host: record.host,
        path: record.path,
        statusCode: record.statusCode,
        duration: record.duration,
        /**
         * 响应体字节数。
         * 只在报文里取不到字段时最有用：0B 说明响应体压根没进来（压缩解不开 / 跳转无 body），
         * 有内容却取不到才是字段名或嵌套深度的问题 —— 两者处理方式完全不同。
         */
        bodyLen: (record.resBody || '').length,
        // 范围外的记录即使解析出同名字段也不能标绿：它不是这台影城的流量
        hit: inScope(record) && Object.keys(got).length > 0,
        params: got
      }
    })

    return {
      ok: true,
      // 缓冲里总条数 vs 本次返回条数：数字差太大说明窗口取小了
      total: ctx.captures.length,
      skipped: Number(ctx.proxy?.stats?.skipped) || 0,
      // 最近被筛掉的几条（带原因）：面板上「已跳过 N 条」不是冷数字，点开能看是哪几条
      skippedItems: (ctx.skippedCaptures || []).slice(-12),
      proxyRunning: Boolean(ctx.proxyRunning),
      // 标志为 true 还不够：真连一下端口，才知道浏览器能不能连上来
      proxyListening: ctx.proxyRunning ? await probePort(ctx.proxy?.port) : false,
      proxyPort: ctx.proxy?.port || 0,
      /**
       * CONNECT 层的连接计数，全给渲染层。
       *
       * 这三个数是「一条都没有」时的分诊依据，缺了就只能靠猜：
       *   total = 0            → 代理一条连接都没收到，流量压根没走系统代理
       *   total > 0 且 tunneled = total → 收到了但全被判成「不用解密」，域名族对不上
       *   intercepted > 0 但请求 0 → 解密了却没入库，是记录/过滤层的 bug
       */
      stats: {
        total: Number(ctx.proxy?.stats?.total) || 0,
        intercepted: Number(ctx.proxy?.stats?.intercepted) || 0,
        tunneled: Number(ctx.proxy?.stats?.tunneled) || 0,
        skipped: Number(ctx.proxy?.stats?.skipped) || 0,
        failed: Number(ctx.proxy?.stats?.failed) || 0
      },
      /**
       * 实际被隧道直通的域名（次数降序，最多 12 条）。
       * 目标系统的域名出现在这里，就说明解密范围配错了 —— 不用再靠猜。
       */
      tunneledHosts: [...(ctx.proxy?.tunneledHosts || new Map())]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([host, count]) => ({ host, count })),
      focus: ctx.focusHosts ? [...ctx.focusHosts] : [],
      // 本次抓包用的系统代号：解密范围为空时，用它判断是不是代号没被认出来
      systemCode: ctx.captureSystemCode || '',
      // 路径特征（mini 的 miniticket）：有值时说明「域名不一定在族内，靠路径也认」
      pathHints: pathHintsOf(ctx.captureSystemCode),
      keys,
      merged,
      records: records.reverse()
    }
  })
)

routers.push(
  new EventRoute('captures:clear', 'invoke', async (api, data) => {
    const { ctx } = api
    const params = (data && data.params) || {}
    ctx.captures = []
    ctx.pendingCaptures = []
    // 计数和明细一起清零：只清 filtered 会让面板显示 0、但展开里还是旧条目；
    // total/tunneled 不清则「清空记录」后连接数还在涨，看不出这一轮到底有没有流量
    if (ctx.proxy?.stats) {
      Object.assign(ctx.proxy.stats, { total: 0, intercepted: 0, tunneled: 0, failed: 0, skipped: 0 })
    }
    if (Array.isArray(ctx.skippedCaptures)) ctx.skippedCaptures.length = 0
    // 直通域名也清：留着旧的一轮，「直通域名」列表会和新的连接数对不上
    if (ctx.proxy?.tunneledHosts) ctx.proxy.tunneledHosts.clear()

    /**
     * 带 systemCode 时顺手把解密范围换成这家系统（显式传空串也算「换一轮，先清空」）。
     *
     * 打开参数弹窗就调这一支：不换的话，点「365系统」时面板「解密范围」还挂着上一家
     * （凤凰的 mtop），而缓冲里也仍是上一家的记录 —— 同名字段（mobile / token / ticket）
     * 会被面板回填进 365 的表格，表现成「还没点获取参数就全填满了」。
     *
     * 「清空记录」按钮不传这个字段，所以它不会把正在用的解密范围弄丢。
     * 这里只做预备：`interceptAll` 不在这里打开，真正放开全量解密是抓包窗口的事。
     */
    if (params.systemCode !== undefined) {
      const systemCode = String(params.systemCode || '').trim()
      const hosts = systemCode ? seedHosts(systemCode) : []
      ctx.focusHosts = hosts.length ? new Set(hosts) : null
      ctx.captureSystemCode = hosts.length ? systemCode : ''
      ctx.interceptAll = false
    }

    return {
      ok: true,
      systemCode: ctx.captureSystemCode || '',
      focus: ctx.focusHosts ? [...ctx.focusHosts] : [],
      // 域名不固定的系统要把路径特征也亮出来，否则面板只显示一个族名会让人以为只盯这一个域
      pathHints: pathHintsOf(ctx.captureSystemCode)
    }
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
 * 这个字段是不是「人工填」的那几列。
 *
 * 参数弹窗里除了抓包字段，还混着会员成本 / 会员折扣 / 备注这种运营手填的项，
 * 它们永远不会出现在流量里。老数据没有 required 标记时只能靠名字识别，
 * 否则「抓到什么程度算完」的条件永远不成立，用户每次都得干等满 45 秒。
 */
function isManualField(key) {
  // 用包含判断：后台写法不统一（会员成本 / 会员成本折扣 / 影院备注…），整串相等必然漏
  return /备注|说明|成本|折扣|note|remark|memo|comment|discount|cost|fee|price/i.test(String(key || '').trim())
}

/**
 * 没抓齐时，判断到底卡在哪一步，只回一句人话。
 *
 * 「没抓到」这三种原因的处理方式完全不同，不区分就只能让用户反复重试：
 *   1. 一条请求都没有 → 页面没刷新，或系统代理没生效；
 *   2. 有请求但没有登录请求 → 用户是在点「获取参数」**之前**登录的，流量早过去了；
 *   3. 有登录请求但字段没对上 → 字段名不同，要靠诊断文件看真实报文。
 */
function diagnoseMiss(accepted, focus, missing = []) {
  if (!accepted.length) {
    const scope = focus && focus.size ? [...focus].join('、') : ''
    return scope
      ? `本次没有收到 ${scope} 的任何请求：页面可能还没刷新，或系统代理没生效`
      : '本次没有收到任何请求：页面可能还没刷新，或系统代理没生效'
  }

  /**
   * tid 单独说清楚，因为它和别的字段根本不是一路的。
   *
   * 实测（真实 HAR 逐条扫过）：tid **不在任何 cookie 里**，也不在请求头里，
   * 它只出现在 `auth.getsidbytid` 这一条请求的请求体和响应体（`bizValue.tid`）。
   * 而这条请求只在「登录」或「会话过期后换新 sid」时才发 —— 单纯刷新已登录的页面不会产生它。
   * 不把这点讲明，用户会一直以为是抓包漏了，或者去 cookie 里翻一个根本不存在的东西。
   */
  if (missing.some((key) => String(key || '').trim().toLowerCase() === 'tid')) {
    return (
      '缺 tid：它不在 cookie 里，只出现在 auth.getsidbytid 这条请求的请求体 / 响应体里，' +
      '而这条请求只在登录或会话刷新时才发。请在浏览器里退出登录、重新登录一次，再点「获取参数」'
    )
  }

  if (!accepted.some(looksLikeLogin)) {
    return `本次收到 ${accepted.length} 条请求，但里面没有能取到这些字段的接口 —— 请在浏览器里刷新一下页面再试`
  }

  /**
   * 名字压根没出现过，和「出现了但没解析出来」是两种完全不同的处置：
   * 前者再怎么刷新页面也抓不到，说明这套接口不认这个字段（随映的 openId 就属于这种，
   * 适配器发请求时只带 memberId / X-Access-Token / X-Sign，从头到尾不传 openId）。
   */
  const neverSeen = fieldsNeverSeen(accepted, missing)
  if (neverSeen.length) {
    return (
      `这次抓到的 ${accepted.length} 条请求里完全没有出现过 ${neverSeen.join('、')} —— ` +
      '要么这几个字段只在登录环节产生，要么这套接口根本不用它；可以先把它们改成非必填'
    )
  }

  return `登录请求已经抓到，但 ${missing.join('、') || '这几个字段'} 不在里面（字段名可能不同），诊断文件里有原始报文`
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
