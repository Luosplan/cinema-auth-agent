import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  Tray,
  Menu,
  nativeImage,
  session,
  webContents
} from 'electron'
import { join } from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

import EventRouter from './router/EventRouter'
import routers from './router/index'
import CertificateAuthority from './mitm/CertificateAuthority'
import MitmProxy from './mitm/MitmProxy'
import SystemProxy from './mitm/SystemProxy'
import { addBypassHosts } from './mitm/hostBypass'
import { launchMiniapp, launchBySearch, parseAppid } from './wx/WxUi'
import Extractor from './collectors/Extractor'
import { mergeRules } from './collectors/rules'
import ConfigStore from './store/ConfigStore'
import CredentialStore from './store/CredentialStore'
import Reporter from './reporter/Reporter'
import MemberAuth from './auth/MemberAuth'

const APP_TITLE = '影票授权助手'
const MAX_CAPTURES = 300
/**
 * 小程序全量解密时缓冲要放大：整套 TLS 全解，几百条请求十几秒就填满，
 * 而参数恰好出现在「填满之后」是常态 —— 缓冲太小会把登录那一枪挤掉。
 */
const MAX_CAPTURES_OPEN = 1500
const MAX_LOGS = 500

let mainWindow = null
let tray = null
let quitting = false
let shutdownPending = false
let shutdownDone = false
let captureFlushTimer = null
let paramFlowWindow = null
/** 抓包记录序号，见 handleCapture */
let captureSeq = 0

/**
 * 参数窗口用手机 UA 打开：这些页面大多只在手机上看过，桌面 UA 会拿到
 * 「请在微信中打开」的拦截页。
 *
 * 但**不能带 MicroMessenger**：一旦被识别成微信内置浏览器，页面就去等
 * WeixinJSBridge / JSSDK 授权，在 Electron 里永远等不到，表现就是一直转圈白屏。
 * 用普通移动 Safari 的 UA，页面走「手机浏览器」分支，账号密码登录正常可用。
 * 个别系统确实要求微信环境时，可以在规则里写 launch.userAgent 单独覆盖。
 */
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'

/**
 * 「获取参数」专用分区。单独隔一个 session，只为了三件事：
 *   1. 能把代理固定指向本机（不依赖系统代理有没有被 Chromium 感知到）
 *   2. 只对这个窗口放行 MITM 证书错误，主窗口照常严格校验
 *   3. 登录态留在分区里，同一个系统第二次打开不用重新登录
 */
const PARAM_PARTITION = 'persist:param-flow'
/** webRequest 每个事件只允许一个监听器，重复设置会互相覆盖，这里只装一次 */
/** 已经挡过 sw.js 的分区：webRequest 同事件只能挂一个监听器，重复挂会互相覆盖 */
const swBlockedPartitions = new Set()

const ctx = {
  config: null,
  credentials: null,
  ca: null,
  proxy: null,
  systemProxy: null,
  extractor: null,
  reporter: null,
  auth: null,
  logs: [],
  captures: [],
  pendingCaptures: [],
  proxyRunning: false,
  lockFile: '',
  dataDir: ''
}

function log(level, message) {
  const entry = { at: new Date().toISOString(), level, message }
  ctx.logs.push(entry)
  if (ctx.logs.length > MAX_LOGS) ctx.logs.shift()
  broadcast('log', entry)
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: APP_TITLE,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false,
      // 「获取参数」把 H5 嵌在弹窗里看，要用 <webview>
      webviewTag: true
    }
  })

  mainWindow.setMenu(null)

  mainWindow.on('ready-to-show', () => {
    mainWindow.setTitle(APP_TITLE)
    mainWindow.show()
  })


  // 关闭窗口时若开启托盘驻留则隐藏而不退出 —— 采集需要长期在后台跑
  mainWindow.on('close', (e) => {
    const keep = ctx.config?.get('app.minimizeToTray')
    if (!quitting && keep) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  const eventRouter = new EventRouter()
  eventRouter.addApi('ctx', ctx)
  eventRouter.addApi('app', app)
  eventRouter.addApi('BrowserWindow', BrowserWindow)
  eventRouter.addApi('dialog', dialog)
  eventRouter.addApi('fs', fs)
  eventRouter.addApi('log', log)
  eventRouter.addRoutes(routers)

  ipcMain.removeAllListeners('renderer-to-main')
  ipcMain.removeHandler('renderer-to-main-invoke')
  ipcMain.on('renderer-to-main', (event, arg) => {
    eventRouter.router(arg)
  })
  ipcMain.handle('renderer-to-main-invoke', (event, arg) => {
    return eventRouter.router(arg)
  })
}

function createTray() {
  const image = nativeImage.createFromPath(icon)
  tray = new Tray(
    image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 })
  )
  tray.setToolTip(APP_TITLE)
  updateTrayMenu()
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

function updateTrayMenu() {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    {
      label: ctx.proxyRunning ? '采集中（点击停止）' : '已停止（点击开始）',
      click: async () => {
        if (ctx.proxyRunning) await stopProxy()
        else await startProxy()
        updateTrayMenu()
      }
    },
    { type: 'separator' },
    {
      label: '打开面板',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

/**
 * 独立「入口窗口」的网络前置。
 *
 * 这里只做两件事：挡掉 sw.js、清掉旧的 ServiceWorker 注册。
 * 不再把它拧到本机代理 —— 这批 H5 一进代理整页就渲染不出来（同一条链接直连正常），
 * 参数抓取已经改成在内嵌页面里用 CDP 旁听，页面必须保持直连才看得见内容。
 *
 * 为什么每个分区都要挡 sw.js：
 *   注册了 ServiceWorker 之后，页面的 fetch 由 SW 自己接管再转发，
 *   请求归属到 SW 那个 target 上 —— 页面会话里看得到 requestWillBeSent，
 *   getResponseBody 却一律报「No resource with given identifier found」，
 *   于是响应体全丢、cookie 也时有时无。挡掉之后请求回到普通网络栈，才能读到体。
 */
async function prepareCaptureSession(partition = PARAM_PARTITION) {
  const sess = session.fromPartition(partition)

  if (!swBlockedPartitions.has(partition)) {
    swBlockedPartitions.add(partition)
    sess.webRequest.onBeforeRequest((details, callback) => {
      if (/\/sw\.js(\?|$)/i.test(String(details.url || ''))) {
        return callback({ cancel: true })
      }
      callback({})
    })
  }

  // 之前注册过的 SW 会继续从缓存里接管请求（sw.js 拦了也没用），加载前先清掉注册
  try {
    await sess.clearStorageData({ storages: ['serviceworkers'] })
  } catch {
    /* 清不掉不影响主流程 */
  }

  return sess
}

/** 采集停掉后还原入口窗口的会话：清一次 SW，避免下一家影城拿到上家的缓存 */
async function resetParamSession() {
  try {
    await session.fromPartition(PARAM_PARTITION).clearStorageData({ storages: ['serviceworkers'] })
  } catch {
    /* 还原失败不影响主流程 */
  }
}

/**
 * 内嵌页面的抓包：挂 CDP 的 Network 域旁听，不走代理。
 *
 * 为什么放弃 MITM：这批 H5 又是 ServiceWorker、又是 document.write 拉第三方脚本，
 * 一旦套上代理整页就渲染不出来（同一条链接直连是好的，实测对比过）。
 * 而参数本来就存在于页面自己的响应里，读响应体比解密流量更直接 ——
 * 页面照常直连、正常显示，我们只是旁听。
 *
 * 附带好处：不再改系统代理，进程被杀也不会留下代理残留把客户机搞断网。
 */
const debuggerSessions = new Map()
/** 抓包健康度：取体成功/失败、ExtraInfo 是否真的来了 —— 抓不到参数时先看这里 */
const cdpStats = { attach: 0, bodyOk: 0, bodyFail: 0, extraInfo: 0, lastFail: '' }

async function attachPageCapture(webContentsId) {
  const id = Number(webContentsId || 0)
  const wc = id ? webContents.fromId(id) : null
  if (!wc) return { ok: false, message: '找不到内嵌页面，可能已经关闭' }
  if (debuggerSessions.has(id)) return { ok: true, already: true }

  const dbg = wc.debugger
  try {
    dbg.attach('1.3')
  } catch (e) {
    return { ok: false, message: `挂载调试协议失败：${e.message}` }
  }

  const requests = new Map()
  /**
   * ExtraInfo 有时比 requestWillBeSent 先到（Chromium 两条事件不是同一个时序保证），
   * 先到的那份必须暂存下来，否则整条记录的 Cookie 就丢了 ——
   * 表现为「明明登录了，cookie 里就是少字段」。
   */
  const earlyExtra = new Map()
  // 只在开发/排查时需要，生产日志里刷屏没意义
  const trace = Boolean(process.env.CINEMA_CDP_TRACE)
  let bodyFail = 0
  let bodyOk = 0

  /**
   * 事件里会带 sessionId：跨进程 iframe（支付、登录弹层常见）是独立 target，
   * 它的网络事件挂在子会话上，不跟着开一条会话就完全看不到。
   * 主会话的 sessionId 是 undefined，原样传给 sendCommand 即可。
   */
  const listener = (_event, method, params, sessionId) => {
    if (method === 'Target.attachedToTarget') {
      // 新出现的子页面：给它的会话也开上网络域
      const childId = params.sessionId
      if (!childId) return
      dbg
        .sendCommand(
          'Network.enable',
          { maxTotalBufferSize: 100 * 1024 * 1024, maxResourceBufferSize: 10 * 1024 * 1024 },
          childId
        )
        .catch(() => {})
      return
    }

    if (method === 'Network.requestWillBeSent') {
      const early = earlyExtra.get(params.requestId)
      if (early) earlyExtra.delete(params.requestId)
      requests.set(params.requestId, {
        url: params.request?.url || '',
        method: params.request?.method || 'GET',
        reqHeaders: { ...(early || {}), ...(params.request?.headers || {}) },
        reqBody: params.request?.postData ? String(params.request.postData) : '',
        sessionId
      })
      return
    }

    /**
     * Cookie 不在 requestWillBeSent 里 —— CDP 把「浏览器实际发出去的请求头」
     * 单独放在 ExtraInfo 事件里，Cookie / Set-Cookie 只在这里出现。
     * 而 H5 的 tid / _m_h5_tk 恰恰只在 cookie 里，漏了这一步等于白挂。
     */
    if (method === 'Network.requestWillBeSentExtraInfo') {
      cdpStats.extraInfo += 1
      const item = requests.get(params.requestId)
      if (!item) {
        earlyExtra.set(params.requestId, params.headers || {})
        // 攒太多说明配对一直没来，防内存漏水
        if (earlyExtra.size > 500) earlyExtra.delete(earlyExtra.keys().next().value)
        return
      }
      item.reqHeaders = { ...item.reqHeaders, ...(params.headers || {}) }
      return
    }

    if (method === 'Network.responseReceived') {
      const item = requests.get(params.requestId)
      if (!item) return
      item.statusCode = params.response?.status
      // 合并而不是覆盖：ExtraInfo 里可能已经有 Set-Cookie 了
      item.resHeaders = { ...(item.resHeaders || {}), ...(params.response?.headers || {}) }
      item.mimeType = params.response?.mimeType || ''
      return
    }

    if (method === 'Network.responseReceivedExtraInfo') {
      const item = requests.get(params.requestId)
      if (!item) return
      item.resHeaders = { ...(item.resHeaders || {}), ...(params.headers || {}) }
      return
    }

    if (method === 'Network.loadingFinished') {
      const item = requests.get(params.requestId)
      if (!item) return
      requests.delete(params.requestId)

      /**
       * 一条记录只要 URL / 请求头就已经有价值（cookie 里的 tid、_m_h5_tk 都在这），
       * 所以取不到响应体也照样上报，只是把 resBody 留空 ——
       * 早先这里取体失败就整条丢掉，结果最关键的 cookie 参数一起没了。
       */
      const emit = (body) => {
        let host = ''
        let path = ''
        try {
          const u = new URL(item.url)
          host = u.hostname
          path = u.pathname + u.search
        } catch {
          return
        }
        handleCapture({
          id: `${Date.now()}-${params.requestId}`,
          at: new Date().toISOString(),
          host,
          method: item.method,
          path,
          statusCode: item.statusCode,
          reqHeaders: item.reqHeaders,
          resHeaders: item.resHeaders,
          reqBody: item.reqBody,
          resBody: body
        })
      }

      // 图片/字体这类体积大又不可能带参数，直接跳过
      if (item.mimeType && !/json|text|javascript|html|xml/i.test(item.mimeType)) return

      /**
       * sessionId 只在跨进程子框架里才有。主会话必须「不传」这个参数 ——
       * 传 undefined 会被 CDP 当成空 session 拒掉（Empty session id is not allowed），
       * 于是所有响应体都取不到。
       */
      const args = [{ requestId: params.requestId }]
      if (item.sessionId) args.push(item.sessionId)

      dbg
        .sendCommand('Network.getResponseBody', ...args)
        .then((res) => {
          let body = res.body || ''
          if (res.base64Encoded) {
            try {
              body = Buffer.from(body, 'base64').toString('utf8')
            } catch {
              body = ''
            }
          }
          bodyOk += 1
          cdpStats.bodyOk += 1
          if (trace && bodyOk <= 30) {
            log('info', `[cdp] ${item.mimeType} ${body.length}B ${item.url.slice(0, 70)}`)
          }
          emit(body)
        })
        .catch((e) => {
          // 重定向、304、缓存命中本来就没有响应体，取不到属正常，记录照样上报
          bodyFail += 1
          cdpStats.bodyFail += 1
          cdpStats.lastFail = `${e.message} ${String(item.url).slice(0, 60)}`
          if (trace && bodyFail <= 10) log('warn', `[cdp] 取响应体失败：${e.message}`)
          emit('')
        })
      return
    }

    if (method === 'Network.loadingFailed') requests.delete(params.requestId)
  }

  dbg.on('message', listener)
  try {
    // 缓冲给足：默认缓冲在长页面上会把早期响应体挤掉，getResponseBody 就只回空
    await dbg.sendCommand('Network.enable', {
      maxTotalBufferSize: 100 * 1024 * 1024,
      maxResourceBufferSize: 10 * 1024 * 1024,
      maxPostDataSize: 5 * 1024 * 1024
    })
  } catch {
    /* 老版本协议没有 Network.enable 时也不阻塞 */
  }
  try {
    // 跨进程 iframe 默认不在这个会话里，开启自动跟随才能收到它们的网络事件
    await dbg.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    })
  } catch {
    /* 部分版本对 Target 域有限制，抓不到子框架也不影响主文档 */
  }
  debuggerSessions.set(id, { dbg, listener })
  return { ok: true }
}

function detachPageCapture(webContentsId) {
  const id = Number(webContentsId || 0)
  const item = debuggerSessions.get(id)
  if (!item) return
  try {
    item.dbg.removeListener('message', item.listener)
    item.dbg.detach()
  } catch {
    /* 页面已经销毁时会抛，忽略即可 */
  }
  debuggerSessions.delete(id)
}

/**
 * 找到「获取参数」用的内嵌页面。
 *
 * 为什么不靠渲染进程传 id：页面是后挂上去的，点「获取参数」那一刻 id 还拿不到，
 * 传过来就是 0。主进程自己按 webview 类型 + 入口域名找，省掉一次时序协同。
 */
function findGuestPage(hint = '') {
  let list = []
  try {
    list = webContents.getAllWebContents().filter((wc) => {
      try {
        return wc.getType() === 'webview' && !wc.isDestroyed()
      } catch {
        return false
      }
    })
  } catch {
    return 0
  }
  if (!list.length) return 0
  const key = String(hint || '').toLowerCase()
  if (!key) return list[0].id
  const hit = list.find((wc) => String(wc.getURL() || '').toLowerCase().includes(key))
  return (hit || list[0]).id
}

/**
 * 直接读内嵌页面自己的存储。
 *
 * 有些参数天生抓不到：登录成功时接口只回一次，之后值就常驻在页面的 localStorage 里
 * （凤凰系的 tid / sid 就是这种），操作员登录完再点「获取参数」，流量里根本不会再出现它们。
 * 与其让运营去翻控制台，不如到页面存储里把同名字段捞出来 —— 值本来就是页面自己存着的。
 */
async function readPageStorage(webContentsId) {
  const id = Number(webContentsId || 0)
  const entry = debuggerSessions.get(id)
  if (!entry?.dbg) return { ok: false, message: '页面还没接上调试协议' }

  const expression = `(() => {
    const dump = (store) => {
      const out = {}
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i)
        if (!key) continue
        // 单个条目限长：有的系统把整包配置塞进去，全量搬回来既慢也没用
        out[key] = String(store.getItem(key) == null ? '' : store.getItem(key)).slice(0, 60000)
      }
      return out
    }
    return JSON.stringify({
      url: String(location.href || ''),
      title: String(document.title || ''),
      cookie: String(document.cookie || ''),
      local: dump(window.localStorage),
      session: dump(window.sessionStorage)
    })
  })()`

  try {
    const res = await entry.dbg.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false
    })
    const raw = res?.result?.value
    if (!raw) return { ok: false, message: '页面暂时读不到存储' }
    return { ok: true, data: JSON.parse(raw) }
  } catch (e) {
    return { ok: false, message: e.message }
  }
}

/**
 * 把页面存储拍成一条「伪抓包记录」，好复用同一套按名匹配。
 *
 * 存储里的值大多是 JSON 字符串，纯文本扫描是扫不到 user.tid 的，
 * 所以先把能解析的再挂成对象（key 加 #json 后缀，避免和原始字符串互相覆盖）。
 */
function storageToRecord(data) {
  const merged = {}
  const scopes = [
    ['local', data?.local],
    ['session', data?.session]
  ]
  for (const [scope, store] of scopes) {
    if (!store || typeof store !== 'object') continue
    for (const [key, raw] of Object.entries(store)) {
      const full = `${scope}:${key}`
      merged[full] = raw
      const text = String(raw || '').trim()
      if (!text || (text[0] !== '{' && text[0] !== '[')) continue
      try {
        merged[`${full}#json`] = JSON.parse(text)
      } catch {
        /* 不是合法 JSON 就只留原始字符串 */
      }
    }
  }
  if (data?.cookie) merged['@cookie'] = data.cookie

  return {
    id: `storage-${Date.now()}`,
    at: new Date().toISOString(),
    host: '__page_storage__',
    method: 'STORE',
    path: '/page-storage',
    reqHeaders: {},
    resHeaders: {},
    reqBody: '',
    resBody: JSON.stringify(merged)
  }
}

/**
 * 「打开入口」的兜底动作（独立窗口）。
 *
 * 参数弹窗里现在直接把入口塞进内嵌 webview，这条路径只留给「就是想单独开个窗口看看」
 * 的场景（cinemas:entry:open）。窗口同样走直连，靠 CDP 旁听抓包。
 *
 * 打开顺序（能开的先开）：
 *   1. 出票程序自己的 H5 地址（后台 CinemaGroup.accessUrl）—— 最可靠。
 *   2. 规则里配的 H5 地址（有些系统所有影城共用一个入口）。
 *   3. 纯小程序：只能唤起微信。`weixin://dl/business/?appid=` 只能把微信拉到前台，
 *      不能直达某个页面，微信侧通常回「当前页面无法访问」—— 这条只是尽力而为的兜底。
 */
async function openEntry(rule, cinema = {}) {
  // 影城自己的入口（后台 accessUrl / accessAppId）> 这套程序的公共入口
  const accessUrl = String(cinema.accessUrl || '').trim()
  const accessType = String(cinema.accessType || '').toLowerCase()
  const ruleUrl = String(rule?.launch?.url || '').trim()
  const url = accessUrl || ruleUrl
  // 入口直接写成 launchapplet 链接时，链接里的 appid 比后台字段更可信
  const appid = String(parseAppid(url) || cinema.accessAppId || rule?.launch?.appid || '').trim()

  // 有 H5 地址就开窗，不管 accessType 写的是什么：能进页面才有流量
  if (url) {
    /**
     * weixin:// 链接不交给系统打开、也不塞进 webview。
     *
     * 塞 webview 就是一块白屏（浏览器内核不认识这个 scheme）；
     * 早先交给系统打开时微信又把它当普通网址丢进内置浏览器，停在「对不起，当前页面无法访问」。
     * 这条链接唯一正确的用法是交给 launchMiniapp 走 ShellExecute，由调用方执行。
     */
    if (/^weixin:\/\//i.test(url) || /^wx[a-z0-9]{16}$/i.test(url)) {
      const name = rule?.launch?.name || rule?.name || cinema.name || '该小程序'
      return { ok: false, mode: 'miniapp', needsMiniappLaunch: true, url, appid, name }
    }

    try {
      // eslint-disable-next-line no-new
      new URL(url)
    } catch {
      return { ok: false, message: `入口地址不是合法链接：${url}` }
    }

    const userAgent = rule?.launch?.userAgent || MOBILE_UA
    // 先把网络前置做好再 loadURL：sw.js 挡晚一步，首屏就被 ServiceWorker 接走了
    await prepareCaptureSession(PARAM_PARTITION)

    if (paramFlowWindow && !paramFlowWindow.isDestroyed()) {
      paramFlowWindow.setTitle(`${cinema.name || rule?.name || ''} · 获取参数`)
      paramFlowWindow.focus()
      paramFlowWindow.loadURL(url, { userAgent })
      return { ok: true, mode: 'h5', url, hint: `已打开 ${cinema.name || rule?.name || ''} 的 H5 页面，在里面登录一次即可` }
    }

    paramFlowWindow = new BrowserWindow({
      width: 430,
      height: 780,
      minWidth: 360,
      minHeight: 560,
      title: `${cinema.name || rule?.name || ''} · 获取参数`,
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARAM_PARTITION,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    paramFlowWindow.setMenu(null)
    paramFlowWindow.on('closed', () => {
      paramFlowWindow = null
      // 采集过程中的窗口关闭会立刻结束等待，留一行日志，排查「怎么没抓到就停了」
      log('info', '参数窗口已关闭')
    })
    // 打不开要能说清是域名挂了还是证书/网络问题，否则用户只看到白屏
    paramFlowWindow.webContents.on('did-fail-load', (_e, code, desc, failedUrl) => {
      ctx.lastEntryError = `页面加载失败（${code} ${desc}）：${failedUrl}`
      log('error', 'param-entry', ctx.lastEntryError)
    })
    paramFlowWindow.loadURL(url, { userAgent })
    return {
      ok: true,
      mode: 'h5',
      url,
      hint: `已打开 ${cinema.name || rule?.name || ''} 的 H5 页面，在里面登录一次即可`
    }
  }

  if (accessType === 'miniapp' || rule?.launch?.type === 'miniapp') {
    const name = rule?.launch?.name || rule?.name || cinema.name || '该小程序'
    /**
     * 这里曾经拼 `weixin://dl/business/?appid=` 交给系统打开，结果是
     * 微信把它当普通网址丢进内置浏览器、页面报「对不起，当前页面无法访问」。
     * 那条路要求小程序管理员在自己的后台开「明文 Scheme」，我们这些影城开不了。
     * 现在统一交给 launchMiniapp 用 `launchapplet` 那条链接，由调用方决定要不要执行。
     */
    return {
      ok: false,
      mode: 'miniapp',
      needsMiniappLaunch: true,
      appid,
      name,
      message: appid
        ? `已准备用 appid 直达《${name}》`
        : `《${name}》还没有 appid：后台填好 accessAppId 才能一键直达`
    }
  }

  return { ok: false, message: '这套系统没有配置 H5 入口，也拿不到小程序 appid' }
}

async function startProxy() {
  if (ctx.proxyRunning) return { running: true, port: ctx.proxy.port }

  const port = ctx.config.get('proxy.port') || 9090
  ctx.extractor.setRules(mergeRules(ctx.config.get('rules')))

  if (!ctx.extractor.activeRules.some((r) => (r.hosts || []).length)) {
    log('warn', '没有任何系统配置了域名，采集不会生效。请先在「影城配置」里填写接口域名')
  }

  const actualPort = await ctx.proxy.start(port)
  await ctx.systemProxy.enable(actualPort)

  ctx.proxyRunning = true
  writeLock(actualPort)
  log('info', `采集已启动，系统代理指向 127.0.0.1:${actualPort}`)
  updateTrayMenu()
  return { running: true, port: actualPort }
}

async function stopProxy() {
  if (!ctx.proxyRunning) return { running: false }

  ctx.proxyRunning = false
  await ctx.systemProxy.disable()
  await ctx.proxy.stop()
  // 采集停了，按入口链接临时放行的域名一并收回，别让代理一直解密这些站点
  ctx.extractor.clearExtraHosts()
  // 全量解密是采集期特权，停代理必须一起关掉，否则客户机所有 HTTPS 长期被解开
  ctx.extractor.setOpenCapture(false)
  await resetParamSession()
  clearLock()
  log('info', '采集已停止，系统代理已还原')
  updateTrayMenu()
  return { running: false }
}

/**
 * 崩溃兜底：启动时若发现上次的 lock 还在，说明进程被强杀过，
 * 系统代理极可能残留，立刻按备份还原 —— 否则客户机会整个断网。
 */
function writeLock(port) {
  try {
    fs.writeFileSync(
      ctx.lockFile,
      JSON.stringify({ port, backup: ctx.systemProxy.backup, at: Date.now() }, null, 2),
      'utf8'
    )
  } catch {
    /* ignore */
  }
}

function clearLock() {
  try {
    if (fs.existsSync(ctx.lockFile)) fs.unlinkSync(ctx.lockFile)
  } catch {
    /* ignore */
  }
}

async function recoverStaleProxy() {
  if (!fs.existsSync(ctx.lockFile)) return
  try {
    const data = JSON.parse(fs.readFileSync(ctx.lockFile, 'utf8'))
    log('warn', '检测到上次异常退出，正在还原系统代理设置')
    await ctx.systemProxy.restoreFrom(data.backup)
    log('info', '系统代理已还原')
  } catch (e) {
    log('error', `还原系统代理失败：${e.message}`)
  } finally {
    clearLock()
  }
}

/**
 * 同步兜底。用户强制结束进程时只有同步调用有机会执行，
 * 异步链根本来不及跑完。
 */
function syncRestoreProxy() {
  if (process.platform !== 'win32') return
  try {
    const { backup } = JSON.parse(fs.readFileSync(ctx.lockFile, 'utf8'))
    if (!backup) return

    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const put = (name, type, value) => {
      execFileSync('reg', ['add', base, '/v', name, '/t', type, '/d', String(value), '/f'], {
        windowsHide: true,
        timeout: 5000
      })
    }

    put('ProxyEnable', 'REG_DWORD', Number(backup.proxyEnable) === 1 ? 1 : 0)
    put('ProxyServer', 'REG_SZ', backup.proxyServer || '')
    put('ProxyOverride', 'REG_SZ', backup.proxyOverride || '')
  } catch {
    /* 兜底失败只能依赖下次启动的 recoverStaleProxy */
  }
}

/**
 * 抓包回调：先缓存原始记录，再尝试提取凭证。
 * 原始记录节流批量推送，否则高频请求会把渲染进程打满。
 */
function handleCapture(record) {
  // 单调递增序号：ctx.captures 到上限会从头裁剪，光靠数组下标判断「哪些是新的」
  // 在裁剪后必然错位（丢记录或重复扫），小程序全量解密时裁得尤其快
  record._seq = ++captureSeq
  ctx.pendingCaptures.push(record)
  if (ctx.pendingCaptures.length > 50) ctx.pendingCaptures.shift()

  if (!captureFlushTimer) {
    captureFlushTimer = setTimeout(() => {
      captureFlushTimer = null
      const batch = ctx.pendingCaptures.splice(0, ctx.pendingCaptures.length)
      if (!batch.length) return
      ctx.captures.push(...batch)
      const limit = ctx.extractor?.openCapture ? MAX_CAPTURES_OPEN : MAX_CAPTURES
      if (ctx.captures.length > limit) {
        ctx.captures.splice(0, ctx.captures.length - limit)
      }
      broadcast('capture-batch', batch)
    }, 400)
  }

  try {
    const hit = ctx.extractor.extract(record)
    if (!hit) return

    const rule = ctx.extractor.activeRules.find((r) => r.id === hit.ruleId)
    const { changed, entry } = ctx.credentials.upsert({
      ruleId: hit.ruleId,
      taskName: rule?.name || hit.ruleId,
      account: hit.account,
      token: hit.token,
      expiresAt: hit.expiresAt,
      source: hit.source,
      at: hit.at,
      extra: hit.extra
    })

    if (!changed) return

    log('info', `已捕获 ${rule?.name || hit.ruleId} 凭证（${entry.account || '未知账号'}）`)
    broadcast('credential-updated', entry)

    const plain = ctx.credentials.getToken(hit.ruleId)
    if (plain) {
      ctx.reporter
        .push({
          ruleId: hit.ruleId,
          taskName: rule?.name,
          account: hit.account,
          token: plain.token,
          extras: plain.extras,
          expiresAt: hit.expiresAt,
          updatedAt: entry.updatedAt,
          source: hit.source
        })
        .catch(() => {})
    }
  } catch (e) {
    log('error', `提取凭证失败：${e.message}`)
  }
}

async function shutdown() {
  try {
    if (ctx.proxyRunning) {
      ctx.proxyRunning = false
      await ctx.systemProxy.disable()
      await ctx.proxy.stop()
    }
  } catch {
    /* ignore */
  } finally {
    clearLock()
  }
}

// 调试开关：CINEMA_CDP=9222 时开远程调试端口，用来核查参数窗口到底有没有走代理、
// 加载成功没成功。不设这个环境变量就完全不生效，打包版不受影响。
if (process.env.CINEMA_CDP) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.CINEMA_CDP))
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.cinemaauth.agent')

  // Windows 上按一下 Alt 就会把原生菜单栏（File/Edit/View…）顶出来，
  // 这个工具没有菜单功能，直接整条去掉，Alt 就成了空操作。
  Menu.setApplicationMenu(null)

  /**
   * 页面里的微信 scheme 一律吞掉。
   *
   * H5 售票页大量用 `wvjbscheme://`（微信 JSSDK 桥）和 `weixin://` 做跳转/唤起。
   * 交给系统只能走 shell.openExternal —— Windows 弹出「获取打开此 'wvjbscheme'
   * 链接的应用」，页面还在原地等回调，表现就是一直转圈白屏。
   * 桌面端本来就没有对应的小程序/微信处理程序，直接拦下，页面才会走浏览器分支。
   */
  const IGNORED_SCHEME =
    /^(weixin|wvjbscheme|weixinbr|weixinqy|alipays|mqqapi|mqq|tbopen|openapp):/i

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler((details) => {
      const url = String(details.url || '')
      // 只有普通网页才交给系统浏览器，其余 scheme 一律拦掉
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {})
      return { action: 'deny' }
    })

    const blockScheme = (event, url) => {
      const target = String(url || '')
      if (!IGNORED_SCHEME.test(target)) return
      // 不 preventDefault 的话，系统会弹「获取打开此 'wvjbscheme' 链接的应用」
      event.preventDefault()
      log('info', `已忽略页面内的微信跳转：${target.slice(0, 50)}`)
    }

    contents.on('will-navigate', (event, url) => blockScheme(event, url))
    // 子 frame 的跳转只有这个事件能拦到（will-navigate 只管主框架），
    // 售票页大量把 wvjbscheme 塞在 iframe 里跳，漏了它弹窗就还在
    contents.on('will-frame-navigate', (event) => blockScheme(event, event.url))
    contents.on('will-redirect', (event, url) => blockScheme(event, url))
  })

  ctx.dataDir = app.getPath('userData')
  ctx.lockFile = join(ctx.dataDir, 'proxy-active.lock')

  ctx.config = new ConfigStore(ctx.dataDir)
  ctx.config.load()

  ctx.credentials = new CredentialStore(ctx.dataDir)
  ctx.credentials.load()

  ctx.ca = new CertificateAuthority(join(ctx.dataDir, 'ca'))
  ctx.ca.init()

  ctx.extractor = new Extractor(mergeRules(ctx.config.get('rules')))

  ctx.systemProxy = new SystemProxy()
  ctx.reporter = new Reporter({
    configStore: ctx.config,
    credentialStore: ctx.credentials,
    dir: ctx.dataDir,
    onLog: log,
    version: app.getVersion()
  })

  // 会员登录复用 reporter 的 agentId 当 deviceId：
  // 服务端是单设备登录模型，这个值必须一次生成、永不变化。
  // 接口地址固定取 config/endpoints.js（会员端同一套服务端），不做用户配置项。
  ctx.auth = new MemberAuth({
    dir: ctx.dataDir,
    deviceId: ctx.reporter.agentId,
    onLog: log
  })
  ctx.auth.load()

  /**
   * 自己的服务端不能解：全量解密时本进程的请求也会绕进代理，
   * 而主进程 fetch 走 Node 证书库、不认 Windows 根存储，解了等于把接口打断。
   */
  try {
    addBypassHosts([new URL(ctx.auth.baseUrl).hostname])
  } catch {
    /* 地址异常不影响启动，最坏情况是采集期间会员端接口报错 */
  }

  ctx.proxy = new MitmProxy({
    ca: ctx.ca,
    matchHost: (host) => ctx.extractor.matchHost(host)
  })
  ctx.proxy.onCapture = handleCapture
  ctx.proxy.onLog = log

  // 挂到 ctx 上，供渲染层的 IPC 路由调用
  ctx.startProxy = startProxy
  ctx.stopProxy = stopProxy
  ctx.openEntry = openEntry
  /** 采集收尾时的诊断要往界面日志里写一行（例如「缺 token，本轮凭证类字段名是这些」） */
  ctx.log = log
  /**
   * 小程序唯一的启动方式：weixin://launchapplet/?app_id=（微信「添加到桌面」用的那条链接）。
   * 直开的前提是该小程序被「添加到电脑桌面」过一次，细节见 wx/WxUi.js 的注释。
   */
  ctx.launchMiniapp = launchMiniapp
  /** scheme 的兜底：靠微信搜索框进小程序，绕过「添加到电脑桌面」的登记要求 */
  ctx.launchBySearch = launchBySearch
  /** 参数窗口/内嵌 webview 统一用手机 UA，否则这些 H5 会返回「请在微信中打开」 */
  ctx.mobileUA = MOBILE_UA
  ctx.prepareCaptureSession = prepareCaptureSession
  ctx.resetParamSession = resetParamSession
  /** 内嵌页面旁听抓包（CDP Network），页面本身直连，不经过代理 */
  ctx.attachPageCapture = attachPageCapture
  ctx.detachPageCapture = detachPageCapture
  ctx.findGuestPage = findGuestPage
  /** 小程序采集时系统代理是不是我们起的：只有我们自己起的才在停止时还原 */
  ctx.paramProxyAuto = false
  ctx.readPageStorage = readPageStorage
  ctx.storageToRecord = storageToRecord
  ctx.cdpStats = cdpStats
  /** 抓包是持续过程，主进程边抓边把增量推给渲染进程，弹窗不用等 20 秒才知道有没有值 */
  ctx.sendToRenderer = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }
  /** 参数窗口有没有被操作员关掉 —— 关了就没必要继续等，空等 2 分钟体验最差 */
  ctx.isEntryWindowOpen = () => Boolean(paramFlowWindow && !paramFlowWindow.isDestroyed())
  ctx.updateTrayMenu = updateTrayMenu
  ctx.recoverStaleProxy = recoverStaleProxy

  await recoverStaleProxy()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  createTray()

  if (ctx.config.get('proxy.autoStart')) {
    try {
      await startProxy()
    } catch (e) {
      log('error', `自动启动采集失败：${e.message}`)
    }
  }

  // 上报失败队列定时补发
  setInterval(() => {
    ctx.reporter.flush().catch(() => {})
  }, 60000)

  // 会员会话保活：服务端是单设备会话，长时间不续期会被踢，
  // 六小时静默续一次；断网导致的失败不清理登录态
  if (ctx.auth.isLoggedIn()) {
    ctx.auth.refresh().catch(() => {})
  }
  setInterval(
    () => {
      if (ctx.auth.isLoggedIn()) ctx.auth.refresh().catch(() => {})
    },
    6 * 3600 * 1000
  )

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else if (mainWindow) mainWindow.show()
  })
})

app.on('before-quit', (e) => {
  if (shutdownDone) return
  quitting = true
  e.preventDefault()
  if (shutdownPending) return
  shutdownPending = true
  shutdown().finally(() => {
    shutdownDone = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  const keep = ctx.config?.get('app.minimizeToTray')
  if (process.platform !== 'darwin' && !keep) {
    app.quit()
  }
})

process.on('exit', () => {
  if (ctx.proxyRunning) syncRestoreProxy()
})
