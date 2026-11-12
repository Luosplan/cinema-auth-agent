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
import ConfigStore from './store/ConfigStore'
import CredentialStore from './store/CredentialStore'
import Reporter from './reporter/Reporter'
import MemberAuth from './auth/MemberAuth'

const APP_TITLE = 'HK票务助手'
const MAX_CAPTURES = 300
const MAX_LOGS = 500

let mainWindow = null
let tray = null
let quitting = false
let shutdownPending = false
let shutdownDone = false
let captureFlushTimer = null

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
    /**
     * 无边框：标题栏由渲染层自己画（TitleBar/index.vue）。
     * 保留 thickFrame（默认 true），Windows 才有边缘拖拽缩放和阴影；
     * 拖动区域靠 CSS 的 -webkit-app-region 声明，双击最大化由系统处理。
     */
    frame: false,
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

  /**
   * 无边框后系统不再画 ─ □ ✕，最大化状态只能由渲染层自己维护；
   * 系统菜单/双击标题栏/快捷键也能改变它，所以以事件为准往界面推。
   */
  const pushWindowState = () => {
    broadcast('window-state', { maximized: mainWindow.isMaximized() })
  }
  mainWindow.on('maximize', pushWindowState)
  mainWindow.on('unmaximize', pushWindowState)

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
  // 窗口控制路由要拿当前窗口，用取值函数而不是传对象，避免持有过期引用
  eventRouter.addApi('getWin', () => mainWindow)
  // 卸载根证书后要立刻停采集，路由里通过 api 拿到同一个 stopProxy
  eventRouter.addApi('stopProxy', stopProxy)
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

async function startProxy() {
  if (ctx.proxyRunning) return { running: true, port: ctx.proxy.port }

  const port = ctx.config.get('proxy.port') || 9090
  // 抓包规则已整体移除，解密域名待后续单独接入（设置页会保留入口）。
  ctx.extractor.setRules([])

  if (!ctx.extractor.activeRules.some((r) => (r.hosts || []).length)) {
    log('warn', '当前没有配置解密域名，抓包只记录不提取凭证')
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

  // 抓包规则已整体移除，Extractor 先以空规则集启动，等域名配置接入后再填充
  ctx.extractor = new Extractor([])
  // 临时放行全部 HTTPS 的开关：只在「获取参数」那段抓包窗口里为 true
  ctx.interceptAll = false

  ctx.systemProxy = new SystemProxy()
  ctx.reporter = new Reporter({
    configStore: ctx.config,
    credentialStore: ctx.credentials,
    dir: ctx.dataDir,
    onLog: log,
    version: app.getVersion()
  })

  // 账号登录复用 reporter 的 agentId 当 deviceId：
  // 服务端是单设备登录模型，这个值必须一次生成、永不变化。
  // 接口地址固定取 config/endpoints.js（HK 票务后台），不做用户配置项。
  ctx.auth = new MemberAuth({
    dir: ctx.dataDir,
    deviceId: ctx.reporter.agentId,
    onLog: log
  })
  ctx.auth.load()

  ctx.proxy = new MitmProxy({
    ca: ctx.ca,
    /**
     * 默认只解密「设置 → 抓包规则」里配过的域名，其余直通（不影响客户机别的网站）。
     * `ctx.interceptAll` 是抓包按钮的临时放行开关：没配域名时靠它才能在窗口期内拿到请求头，
     * 抓完立刻复位，不做常驻全量解密。
     */
    matchHost: (host) => Boolean(ctx.interceptAll) || ctx.extractor.matchHost(host)
  })
  ctx.proxy.onCapture = handleCapture
  ctx.proxy.onLog = log

  // 挂到 ctx 上，供渲染层的 IPC 路由调用
  ctx.startProxy = startProxy
  ctx.stopProxy = stopProxy
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

  // 会话保活：服务端是单设备会话，长时间不续期会被踢，
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
