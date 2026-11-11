import EventRoute from './EventRoute'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import fs from 'node:fs'
import { mergeRules } from '../collectors/rules/index.js'
import { paramDef, resolveForKeys, normalizeKey, describeParams } from '../collectors/ParamResolver.js'
import { pickValues, listFieldNames } from '../collectors/ParamCollector.js'
import { isBypassHost } from '../mitm/hostBypass.js'
import { parseAppid, appletUrl } from '../wx/WxUi'

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
    const cinema = params.cinema || {}
    try {
      const launch = api.ctx.openEntry(rule || { id: params.systemCode, launch: {} }, cinema)
      /**
       * 小程序统一走 appid 直达（weixin://launchapplet/?app_id=）。
       * appid 优先取影城自己配的，其次取规则里写死的。
       */
      if (launch?.needsMiniappLaunch) {
        const appid = params.appid || launch.appid || rule?.launch?.appid || ''
        const name = launch.name || rule?.launch?.name || rule?.name || cinema.name || ''
        const res = await api.ctx.launchMiniapp(appid, name)
        return { ...launch, ...res, appid, name }
      }
      return launch
    } catch (e) {
      return { ok: false, message: e.message }
    }
  })
)

/**
 * 「用搜索打开」：scheme 指望不上时的兜底。
 *
 * `launchapplet` 只对「添加到电脑桌面」过的小程序生效，未登记时微信静默丢弃，
 * 而影城上百家又不可能每家都去登记。这里改成界面自动化：把名字填进微信搜索框、
 * 回车进第一个结果 —— 操作员手工也是这么干的，只是交给我们按键。
 */
routers.push(
  new EventRoute('cinemas:miniapp:search-open', 'invoke', async (api, data) => {
    const params = data.params || {}
    const name = String(params.name || params.cinema?.name || '').trim()
    if (!name) return { ok: false, message: '缺少小程序名，无法搜索' }
    if (typeof api.ctx.launchBySearch !== 'function') {
      return { ok: false, message: '当前版本不支持搜索打开' }
    }
    try {
      return await api.ctx.launchBySearch(name)
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
  let parsed = null
  try {
    parsed = new URL(String(url))
  } catch {
    return []
  }
  // weixin:// 之类不是网页，没有「要解密的域名」这回事
  if (!/^https?:$/i.test(parsed.protocol)) return []
  const host = parsed.hostname.toLowerCase()
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
    const params = data.params || {}
    const cinema = params.cinema || {}
    const systemCode = String(params.systemCode || cinema.systemCode || '')
    const entryUrl = String(cinema.accessUrl || '').trim()
    const rule = ctx.extractor.activeRules.find((r) => r.id === systemCode) || null
    // 入口写的是 launchapplet 链接时，链接里的 appid 就是最准的那份（直接从桌面快捷方式复制的）
    const appid = String(parseAppid(entryUrl) || cinema.accessAppId || rule?.launch?.appid || '').trim()
    const accessType = String(cinema.accessType || '').toLowerCase()

    /**
     * 小程序分支：没有 H5 链接，只能让真实微信去跑真实小程序。
     *
     * 和 H5 完全不是一件事 —— H5 是我们自己开页面、自己旁听；
     * 小程序跑在微信进程里，我们插不进去（wx.login 的 code 只能由微信客户端生成），
     * 唯一能做的是：① 把系统代理指向本机 ② 放行规则里的域名 ③ 尽力把微信拉起来。
     */
    /**
     * 入口里能认出 appid 的（`weixin://launchapplet/?app_id=wx...` 或直接写 appid），
     * 一律按小程序处理。
     *
     * 这条不能再交给 `!entryUrl` 判断：现场把「入口」直接填成那条 scheme 链接，
     * 结果被判成 H5、塞进 <webview> 加载 `weixin://`，右侧只剩一块白屏、小程序压根没起。
     * 那种链接只有交给 ShellExecute 才有意义。
     */
    const appidFromEntry = parseAppid(entryUrl)
    const weixinEntry = Boolean(appidFromEntry) || /^weixin:/i.test(entryUrl)
    const isMiniapp =
      weixinEntry ||
      (!entryUrl && (accessType === 'miniapp' || rule?.launch?.type === 'miniapp' || !!appid))
    if (isMiniapp) {
      /**
       * 域名不是前置条件，只是加分项。
       *
       * 原来这里要求「必须找到规则、规则必须有 hosts」，结果是二十多套系统里
       * 只有四套配了规则，其余全部门都进不去。小程序这条路本来就不该依赖域名清单：
       * 打开全量解密，靠字段名匹配捞值，规则里的 hosts 有就顺带放行（少解一点是一点）。
       */
      const ruleHosts = (rule?.hosts || []).filter(Boolean)
      const hosts = ruleHosts

      let proxy = { running: false }
      try {
        // 只有本来没跑的时候才记「是我们起的」，停采集时才能放心还原系统代理
        ctx.paramProxyAuto = !ctx.proxyRunning
        proxy = await ctx.startProxy()
      } catch (e) {
        return { ok: false, message: `启动抓包代理失败：${e.message}` }
      }
      ctx.extractor.setOpenCapture(true)
      if (ruleHosts.length) ctx.extractor.allowHosts(ruleHosts)

      // 唤起微信。PC 上唯一可用的形式是 appid 版 launchapplet 链接（见 wx/WxUi.js）
      const miniappName = rule?.launch?.name || rule?.name || cinema.name || ''
      let launch = null
      try {
        const opened = await ctx.openEntry(rule, cinema)
        if (opened?.needsMiniappLaunch) {
          const useAppid = appid || opened.appid || rule?.launch?.appid || ''
          const res = await ctx.launchMiniapp(useAppid, miniappName)
          launch = { ...opened, ...res, appid: useAppid, name: miniappName }
        } else {
          launch = opened
        }
      } catch (e) {
        launch = { ok: false, message: e.message }
      }

      return {
        ok: true,
        mode: 'miniapp',
        appid,
        hosts,
        ruleHosts,
        /** 全量解密：界面上要说清楚「客户机流量这一轮都经过本机」 */
        openCapture: true,
        /** 小程序唯一可用的直达链接（微信「添加到桌面」用的那条）；appid 不合法时给空串，界面显示「—」 */
        scheme: appletUrl(appid),
        miniappName: rule?.launch?.name || rule?.name || cinema.name || '',
        proxyRunning: Boolean(proxy.running),
        proxyPort: proxy.port,
        launch
      }
    }

    if (!entryUrl) return { ok: false, message: '该影城没有配置入口链接，无法打开' }

    // 先把页面的 session 收拾干净（挡 sw.js + 清旧注册）再让渲染进程加载链接：
    // 顺序反了，首屏请求就被 ServiceWorker 接管，响应体再也读不到
    if (typeof ctx.prepareCaptureSession === 'function') {
      try {
        await ctx.prepareCaptureSession(PARAM_WEB_PARTITION)
      } catch {
        /* 收拾失败不影响打开页面 */
      }
    }

    return {
      ok: true,
      mode: 'h5',
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
    const accessType = String(cinema.accessType || '').toLowerCase()
    /**
     * 小程序判定必须放在「没有链接就退出」之前。
     *
     * 小程序本来就既没有 accessUrl 也不一定有规则（二十多套系统里只有四套配了规则），
     * 先判链接会把绝大多数小程序影城直接挡在门外 —— 表现为点了「获取参数」立刻弹红条
     * 「该影城没有配置入口链接」，而这时候代理其实已经起好了。
     *
     * 入口填成 `weixin://launchapplet/?app_id=...` 的也算小程序（见 prepare-params 里的说明）。
     */
    const appidFromEntry = parseAppid(entryUrl)
    const isMiniapp =
      Boolean(appidFromEntry) ||
      /^weixin:/i.test(entryUrl) ||
      (!entryUrl &&
        (accessType === 'miniapp' || rule?.launch?.type === 'miniapp' || !!cinema.accessAppId))

    if (!entryUrl && !rule && !isMiniapp) {
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
    const activeRule = rule || {
      id: systemCode || '__entry__',
      name: cinema.name || '影城入口链接',
      enabled: true,
      hosts: entryHosts,
      params: keys.map((key) => ({ key })),
      launch: entryUrl ? { type: 'h5', url: entryUrl } : { type: 'miniapp' }
    }

    const seq = ++paramCaptureSeq

    /**
     * 小程序模式：没有页面可旁听，只能靠代理截微信的网络栈。
     *
     * prepare-params 那一步已经起过代理了，这里再兜一次（幂等）：
     * 渲染进程有可能跳过 prepare 直接点采集，代理没跑就等于白抓。
     */
    if (isMiniapp) {
      try {
        if (!ctx.proxyRunning) {
          ctx.paramProxyAuto = true
          await ctx.startProxy()
        }
        // 全量解密：小程序没有入口链接，也没有域名清单，只能全解开靠字段名捞
        ctx.extractor.setOpenCapture(true)
        if (rule?.hosts?.length) ctx.extractor.allowHosts(rule.hosts)
      } catch (e) {
        return { ok: false, message: `启动抓包代理失败：${e.message}` }
      }
    }

    // 页面由弹窗里的 <webview> 自己加载（直连），H5 模式不再起代理：
    // 这批 H5 一旦套代理就渲染不出来，抓包改由 CDP 旁听响应体。
    let launch = null
    if (params.launch !== false && typeof ctx.openEntry === 'function') {
      try {
        launch = await ctx.openEntry(activeRule, cinema)
        // 小程序没有可打开的链接，只能按 appid 走 launchapplet（见 wx/WxUi.js）
        if (launch?.needsMiniappLaunch) {
          const res = await ctx.launchMiniapp(
            launch.appid || appidFromEntry || rule?.launch?.appid || '',
            launch.name || ''
          )
          launch = { ...launch, ...res }
        }
      } catch (e) {
        launch = { ok: false, message: `打开入口失败：${e.message}` }
      }
    }

    // 小程序侧没有内嵌页可读，页面存储兜底这条路直接关掉
    if (isMiniapp) launch = launch || { ok: true, mode: 'miniapp' }

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

    /**
     * 增量扫描要靠记录自己的 `_seq`，不能用数组下标。
     *
     * ctx.captures 到上限会从头部裁剪，长度不变、下标整体前移。用「数组长度」当进度
     * 的话，裁剪一开始进度就永远追不上，表现为「代理明明在解包，弹窗一个值都不来」——
     * 小程序全量解密时几秒就填满缓冲，这个坑必踩。
     */
    let lastSeq = ctx.captures.length
      ? ctx.captures[ctx.captures.length - 1]._seq || 0
      : 0

    /**
     * 域名判定：全量解密时除了例外表都算，否则只认「正式规则域名 + 入口链接域名」。
     *
     * 为什么还要带上入口域名：影城的入口链接域名和各系统规则里写死的域名经常不一致
     * （同一个出票系统，几十家影城各挂在自己的 H5 域名下），只认规则会把这一轮的
     * 流量全部过滤掉 —— 表现为抓了两分钟什么也没有。
     */
    const entryRule = { hosts: entryHosts }
    const inScope = (host) =>
      ctx.extractor.hostMatches(activeRule, host) ||
      (entryHosts.length ? ctx.extractor.hostMatches(entryRule, host) : false) ||
      // 全量解密模式：任何被解开的域名都算本轮可见范围（例外表里的根本不会进来）
      (ctx.extractor.openCapture && !isBypassHost(host))

    const scanNew = () => {
      const list = ctx.captures
      if (!list.length) return
      // 从尾部往前找第一条还没扫过的记录，作为本轮起点，再正序处理（后写覆盖先写）
      let start = list.length
      while (start > 0 && (list[start - 1]._seq || 0) > lastSeq) start -= 1
      for (let i = start; i < list.length; i += 1) {
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
      lastSeq = list[list.length - 1]._seq || lastSeq
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
      if (isMiniapp && seq === paramCaptureSeq) ctx.extractor.setOpenCapture(false)
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

    /**
     * 页面存储兜底。
     *
     * 凤凰（phoenix）这类系统的 tid / sid 只在登录成功那一次接口里出现，
     * 之后值就常驻页面 localStorage（base.user.tid / base.user.sid），
     * 运营登录完再点「获取参数」时流量里不会再出现它们 —— 只靠抓包永远等不到。
     * 所以每一轮都去页面存储里捞一遍，优先级压到比抓包低（0.5），
     * 有真实流量命中时仍然以流量为准。
     */
    let pageId = Number(params.webContentsId || 0) || 0
    let pageAttached = false
    let storageReads = 0
    let storageState = '待挂载'

    const scanStorage = async () => {
      if (typeof ctx.findGuestPage !== 'function') return
      if (!pageId) {
        pageId = ctx.findGuestPage(entryHosts[0] || '')
        if (!pageId) return
      }
      if (!pageAttached) {
        pageAttached = true
        try {
          await ctx.attachPageCapture(pageId)
        } catch {
          /* 挂不上就只靠抓包 */
        }
      }
      try {
        const res = await ctx.readPageStorage(pageId)
        if (!res.ok) {
          // 读失败不计入次数：下一轮还得接着试，否则要干等三轮才重试
          storageState = res.message
          return
        }
        storageReads += 1
        storageState = `已读 ${storageReads} 次`
        const record = ctx.storageToRecord(res.data)
        const rest = keys.filter((key) => !strict.has(key) && (rank[key] || 0) < 2)
        if (!rest.length) return
        for (const [key, value] of Object.entries(pickValues(record, rest))) {
          put(key, value, '页面存储', 0.5)
        }
      } catch (e) {
        storageState = e.message
      }
    }

    if (!isMiniapp) await scanStorage()
    notify()

    // 后台字段清单里常混着「会员成本」「备注」这种根本不在流量里的字段，
    // 以它们为准会让弹窗每次都干等满超时 —— 等待只盯「必填」和规则声明过的可抓字段
    const requiredKeys = rows
      .filter((row) => row && row.required === true)
      .map((row) => String(row.key || ''))
      .filter(Boolean)
    const declared = new Set(
      (activeRule.params || []).map((item) =>
        normalizeKey(typeof item === 'string' ? item : item?.key || '')
      )
    )
    // 优先级：显式必填 > 规则声明的可抓字段 > 全部
    // （会员成本/备注这类是运营手填的，永远等不到，算进完成条件只会白等）
    const blocking = requiredKeys.length
      ? [...new Set(requiredKeys)]
      : declared.size
        ? keys.filter((key) => declared.has(normalizeKey(key)))
        : keys

    // 登录要时间：默认给 2 分钟，最长 5 分钟；窗口被关掉立刻收工
    const waitMs = Math.min(Math.max(Number(params.waitMs) || 120000, 5000), 300000)
    const deadline = Date.now() + waitMs
    const startedAt = Date.now()
    const h5 = Boolean(launch && launch.ok && launch.mode === 'h5')

    // 收工原因要能说出来：「抓不到」和「你关了窗口」是两件事，混在一起没法排查
    let stopReason = 'timeout'
    let loopIdx = 0
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
      // 小程序没有内嵌页可读，跳过存储通道；
      // 读过之后存储不会自己变，隔几轮再读即可（没读成功时每轮都试）
      if (!isMiniapp) {
        loopIdx += 1
        if (!storageReads || loopIdx % 3 === 0) await scanStorage()
      }
      notify()
    }

    // 采集窗口结束就把全量解密收回：系统代理可以继续挂着，但没必要再解包了。
    // 只收回「自己这一轮」的开关 —— 被新一次「获取参数」顶掉时（superseded），
    // 收工的这一轮不能把下一轮刚打开的全量解密关掉，否则新轮白跑。
    if (isMiniapp && seq === paramCaptureSeq) ctx.extractor.setOpenCapture(false)

    /**
     * 收工时还缺字段：把这一轮「像凭证的字段名」写进日志。
     *
     * 只打名字、绝不打值 —— 名字是排查线索，值是客户的登录凭证，不能进日志。
     * 这一步是为了不再靠猜：token 抓不到时，日志会直接列出接口原本把它叫什么
     * （applet-token / userToken / jwt / sessionkey …），照着补一条别名就行。
     */
    const stillMissing = keys.filter((key) => !values[key])
    if (stillMissing.length && typeof ctx.log === 'function') {
      const AUTH_HINT = /token|auth|session|jwt|ticket|secret|apikey/i
      const seen = new Set()
      // 全量解密时缓冲里能有一千多条，只需要最近的一批来试名字
      for (const record of ctx.captures.slice(-400)) {
        if (!inScope(record.host)) continue
        for (const name of listFieldNames(record)) {
          if (AUTH_HINT.test(name)) seen.add(name)
        }
      }
      const list = [...seen].slice(0, 12)
      ctx.log(
        'info',
        `缺少 ${stillMissing.join('、')}；本轮凭证类字段名：` +
          (list.length ? list.join(' / ') : '（一条都没有，说明这类接口根本没被解密）')
      )
    }

    /**
     * 这一轮实际解开了哪些域名。
     *
     * 小程序全量解密是「先能抓、再收窄」的路子：运营跑一遍，这里列出来的就是
     * 这套系统真正在用的接口域名。下一次要么补进规则走白名单，要么留着当诊断依据 ——
     * 没有这份清单，「代理在跑但参数不来」永远查不出是哪个域名没解。
     */
    const hitHosts = isMiniapp
      ? [...new Set(ctx.captures.filter((item) => inScope(item.host)).map((item) => item.host))]
          .slice(-20)
          .map((host) => ({
            host,
            count: ctx.captures.filter((item) => item.host === host).length
          }))
          .sort((a, b) => b.count - a.count)
      : []

    return {
      ok: true,
      rows,
      ...snapshot(),
      launch,
      mode: isMiniapp ? 'miniapp' : 'h5',
      proxyRunning: ctx.proxyRunning,
      openCapture: false,
      capturedHosts: hitHosts,
      storage: { pageId, reads: storageReads, state: storageState },
      stopReason,
      timedOut: stopReason === 'timeout'
    }
  })
)

routers.push(
  new EventRoute('cinemas:capture-params:stop', 'invoke', async (api) => {
    const { ctx } = api
    // 序号 +1：正在跑的那一轮下一跳自己 break，已结束的调用不受影响
    paramCaptureSeq += 1
    /**
     * 小程序采集会把系统代理指到本机。既然是「停止」，就得把代理一起收掉，
     * 否则客户机整机流量一直绕本机跑 —— 关掉采集却忘了还原，是最难排查的故障。
     * 只收「这次采集自己起的」那一个，用户本来就在跑的采集不动。
     */
    if (ctx.paramProxyAuto) {
      ctx.paramProxyAuto = false
      try {
        await ctx.stopProxy()
      } catch {
        /* 还原失败不阻断停止流程 */
      }
    }
    // 代理是用户手动开着的话不会走到上面，但全量解密同样必须收回
    ctx.extractor.setOpenCapture(false)
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
      // 见过的域名（含未解密的隧道）：小程序抓不到时先看这里，
      // 能直接看出「微信到底有没有走代理」「要解密的域名配漏了哪个」
      hosts: typeof ctx.proxy.hostReport === 'function' ? ctx.proxy.hostReport().slice(0, 40) : [],
      /** 全量解密是否开着：开着的这段时间客户机所有 HTTPS 都经过本机 */
      openCapture: Boolean(ctx.extractor.openCapture),
      captured: ctx.captures.length,
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
