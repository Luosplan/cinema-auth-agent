import { app, shell, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } from 'electron'
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
import Extractor from './collectors/Extractor'
import { mergeRules } from './collectors/rules'
import ConfigStore from './store/ConfigStore'
import CredentialStore from './store/CredentialStore'
import Reporter from './reporter/Reporter'
import MemberAuth from './auth/MemberAuth'

const APP_TITLE = '影票授权助手'
const MAX_CAPTURES = 300
const MAX_LOGS = 500

let mainWindow = null
let tray = null
let quitting = false
let shutdownPending = false
let shutdownDone = false
let captureFlushTimer = null
let paramFlowWindow = null

/**
 * H5 入口用手机 UA 打开：这些页面大多只在微信里被访问过，
 * 用桌面 UA 会拿到「请在微信中打开」的拦截页。
 */
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.44(0x18002c2f) NetType/WIFI Language/zh_CN'

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
      contextIsolation: false
    }
  })

  mainWindow.setMenu(null)

  mainWindow.on('ready-to-show', () => {
    mainWindow.setTitle(APP_TITLE)
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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
 * 「获取参数」的打开动作。
 *
 * 为什么要自动打开：参数只能从真实流量里来。页面不开、小程序不登录，
 * 采集端就是个哑巴 —— 所以点「获取参数」时先把入口拉起来，
 * 操作员只需要在打开的页面里登录一次，参数会自动陆续抓齐。
 *
 * 打开顺序（能开的先开）：
 *   1. 出票程序自己的 H5 地址（后台 CinemaGroup.accessUrl）—— 最可靠，走内嵌窗口，
 *      请求由 Electron 网络栈发出，自动经过系统代理，所以能被 MITM 解出来。
 *   2. 规则里配的 H5 地址（有些系统所有影城共用一个入口）。
 *   3. 纯小程序：只能唤起微信。`weixin://dl/business/?appid=` 只能把微信拉到前台，
 *      不能直达某个页面，微信侧通常回「当前页面无法访问」—— 这条只是尽力而为的兜底。
 */
function openEntry(rule, cinema = {}) {
  // 本机覆盖 > 后台给这家影城配的 accessUrl > 这套程序的公共入口
  const override = cinema.entry || {}
  const accessUrl = String(override.url || cinema.accessUrl || '').trim()
  const accessType = String(cinema.accessType || '').toLowerCase()
  const ruleUrl = String(rule?.launch?.url || '').trim()
  const url = accessUrl || ruleUrl
  const appid = String(override.appid || rule?.launch?.appid || '').trim()

  // 有 H5 地址就开窗，不管 accessType 写的是什么：能进页面才有流量
  if (url) {
    // 小程序入口常常填的是 weixin:// 链接（scheme 码 / 短链），这类只能交给系统打开，
    // 塞进 BrowserWindow 会直接 ERR_UNKNOWN_URL_SCHEME
    if (/^weixin:\/\//i.test(url) || /^wx[a-z0-9]{16}$/i.test(url)) {
      shell.openExternal(url).catch(() => {})
      return {
        ok: true,
        mode: 'miniapp',
        url,
        hint: `已用微信打开 ${cinema.name || rule?.name || ''} 的小程序入口；若没反应，请在电脑版微信里手动打开，流量同样经过本机代理`
      }
    }

    try {
      // eslint-disable-next-line no-new
      new URL(url)
    } catch {
      return { ok: false, message: `入口地址不是合法链接：${url}` }
    }

    const userAgent = rule?.launch?.userAgent || MOBILE_UA
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
        partition: 'persist:param-flow',
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    paramFlowWindow.setMenu(null)
    paramFlowWindow.on('closed', () => {
      paramFlowWindow = null
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
    const scheme = rule?.launch?.scheme || (appid ? `weixin://dl/business/?appid=${appid}` : '')
    if (scheme) {
      shell.openExternal(scheme).catch(() => {})
      return {
        ok: true,
        mode: 'miniapp',
        hint: `小程序没法用链接直达。已尝试唤起微信《${name}》；若停在「当前页面无法访问」，请在电脑版微信里手动打开该小程序并登录，流量同样会经过本机代理`
      }
    }
    return { ok: false, message: `这套系统只有小程序入口，请在微信里打开《${name}》并登录` }
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
  ctx.pendingCaptures.push(record)
  if (ctx.pendingCaptures.length > 50) ctx.pendingCaptures.shift()

  if (!captureFlushTimer) {
    captureFlushTimer = setTimeout(() => {
      captureFlushTimer = null
      const batch = ctx.pendingCaptures.splice(0, ctx.pendingCaptures.length)
      if (!batch.length) return
      ctx.captures.push(...batch)
      if (ctx.captures.length > MAX_CAPTURES) {
        ctx.captures.splice(0, ctx.captures.length - MAX_CAPTURES)
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

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.cinemaauth.agent')

  // Windows 上按一下 Alt 就会把原生菜单栏（File/Edit/View…）顶出来，
  // 这个工具没有菜单功能，直接整条去掉，Alt 就成了空操作。
  Menu.setApplicationMenu(null)

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
