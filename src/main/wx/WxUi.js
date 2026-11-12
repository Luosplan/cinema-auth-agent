/**
 * 小程序启动（Windows）。
 *
 * ## 为什么只有一条路
 *
 * 微信 PC 端能「用链接打开小程序」的形式只有三种，前两种在我们这种第三方场景下都不可用：
 *
 * 1. `weixin://dl/business/?appid=X&path=Y`（官方「明文 URL Scheme」）
 *    要求小程序管理员在自己的后台「设置 → 基本设置 → 隐私与安全」里勾选
 *    「明文 Scheme 拉起此小程序」。影城的小程序不是我们的，永远开不了这个开关。
 *    在 PC 上实测的表现：微信把它当普通网址丢进内置浏览器，页面报「对不起，当前页面无法访问」。
 *
 * 2. 加密 URL Scheme（服务端调 `generateScheme` 生成，有效期 30 天）
 *    需要目标小程序的 access_token，也就是要 appid + secret。我们同样没有。
 *
 * 3. `weixin://launchapplet/?app_id=wx...`  ← 只用这条
 *    这是微信自己「添加到电脑桌面」生成的快捷方式里存的地址，不需要小程序开发者身份。
 *
 * ## 实测结论（微信 4.1.15.56 / Weixin.exe，2026-11）
 *
 * 这条链接**是有效的**，唯一门槛是该小程序被「添加到电脑桌面」过：
 *
 *   · 《沈阳正播国际影城》`wx9e4f926f3f878fc9` —— 桌面有 .lnk（目标正是带 appid 的
 *     launchapplet），ShellExecuteW 之后 WeChatAppEx +1、立刻弹出标题为小程序名的窗口；
 *   · 《奥斯卡》`wx09d3bba3fe063a04` 等另外 4 个 appid —— 本地 `applet\local\wx...`
 *     缓存都在（说明打开过），但没有桌面快捷方式，执行后进程和窗口**零变化**，
 *     微信静默丢弃，连个错误提示都没有。
 *
 * 所以「4.x 不认这条链接」是错的，真正的条件是「这个 appid 登记过桌面」。
 * 因为失败时微信一声不响，必须由我们自己比对窗口/进程来判定结果，
 * 并把「去添加一次桌面」这一步说清楚 —— 否则界面只能骗自己「已直达」。
 */
import koffi from 'koffi'
import { shell, clipboard } from 'electron'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const user32 = koffi.load('user32.dll')

// 回调类型注册后按名字引用即可，不用留变量
koffi.proto('bool __stdcall CaaEnumProc(intptr hwnd, intptr lParam)')
const EnumWindows = user32.func('bool __stdcall EnumWindows(CaaEnumProc *cb, intptr lParam)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr h, char16_t *s, int n)')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr h, char16_t *s, int n)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr h)')
const IsIconic = user32.func('bool __stdcall IsIconic(intptr h)')
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr h, int cmd)')
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr h)')
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr h)')
const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()')
const GetWindowThreadProcessId = user32.func(
  'uint32 __stdcall GetWindowThreadProcessId(intptr h, void *pid)'
)
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 a, uint32 b, bool f)')
/** 唯一能绕过 Windows 前台锁的激活方式（未公开但 Win10/11 一直可用） */
const SwitchToThisWindow = user32.func('void __stdcall SwitchToThisWindow(intptr h, bool alt)')
const keybd_event = user32.func(
  'void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, intptr extra)'
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const VK = { CTRL: 0x11, F: 0x46, V: 0x56, ENTER: 0x0d, ESC: 0x1b }

/** 敲一下某个键 */
function tapKey (vk) {
  keybd_event(vk, 0, 0, 0)
  keybd_event(vk, 0, 2, 0)
}

/** Ctrl + 某个键 */
function ctrlKey (vk) {
  keybd_event(VK.CTRL, 0, 0, 0)
  keybd_event(vk, 0, 0, 0)
  keybd_event(vk, 0, 2, 0)
  keybd_event(VK.CTRL, 0, 2, 0)
}

/** 微信主窗口的类：4.x 是 Qt，3.x 是 Win32 */
const MAIN_WINDOW_CLASSES = ['Qt51514QWindowIcon', 'WeChatMainWndForPC']

function windowText (hwnd, fn) {
  const buf = Buffer.alloc(1024)
  fn(hwnd, buf, 512)
  return buf.toString('utf16le').replace(/\0[\s\S]*$/, '')
}

function findMainWindow () {
  let hit = 0
  EnumWindows((hwnd) => {
    if (!IsWindowVisible(hwnd)) return true
    const cls = windowText(hwnd, GetClassNameW)
    if (MAIN_WINDOW_CLASSES.some((c) => cls.includes(c))) {
      hit = hwnd
      return false
    }
    return true
  }, 0)
  return hit
}

export function isWeixinRunning () {
  if (process.platform !== 'win32') return false
  // 4.x 是 Weixin.exe，3.x 是 WeChat.exe，两个都算
  for (const exe of ['Weixin.exe', 'WeChat.exe']) {
    try {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true
      })
      if (out.includes(exe)) return true
    } catch {
      /* 查不到就试下一个 */
    }
  }
  return false
}

/** 微信相关进程 pid：主窗口在 Weixin.exe / WeChat.exe，小程序窗口挂在 WeChatAppEx.exe 上 */
function wechatPids () {
  const pids = new Set()
  for (const exe of ['Weixin.exe', 'WeChat.exe', 'WeChatAppEx.exe']) {
    try {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true
      })
      for (const line of out.split(/\r?\n/)) {
        const pid = Number(line.split('","')[1])
        if (pid) pids.add(pid)
      }
    } catch {
      /* 没有这个进程就跳过 */
    }
  }
  return pids
}

function windowPid (hwnd) {
  const buf = Buffer.alloc(4)
  GetWindowThreadProcessId(hwnd, buf)
  return buf.readUInt32LE(0)
}

/**
 * 当前可见的小程序窗口（hwnd → 标题）。
 *
 * 必须按进程归属过滤：Electron 自己的窗口类名也是 Chrome_WidgetWin_1，
 * 只看类名会把「一票通-采集助手」当成小程序窗口，判定永远成功。
 */
function appletWindows () {
  const pids = wechatPids()
  const map = new Map()
  EnumWindows((hwnd) => {
    if (!IsWindowVisible(hwnd)) return true
    const cls = windowText(hwnd, GetClassNameW)
    // 小程序窗口在 4.x 上是 Chrome_WidgetWin_0，3.x 是与主窗口同族的 Qt 窗口
    if (!/Chrome_WidgetWin|Qt51514QWindowIcon/.test(cls)) return true
    const title = windowText(hwnd, GetWindowTextW)
    // 主窗口标题固定是「微信」，小程序窗口标题是小程序名
    if (!title || title === '微信' || title === 'WeChat') return true
    if (!pids.has(windowPid(hwnd))) return true
    map.set(hwnd, title)
    return true
  }, 0)
  return map
}

/**
 * 把指定窗口摆到前台。
 *
 * 实测（Win11 + 微信 4.1.15）：`AttachThreadInput + SetForegroundWindow` 会**返回 true
 * 但前台根本没动**（Windows 前台锁），是之前「明明调了没效果」的根源。
 * `SwitchToThisWindow` 才是真正生效的那条，所以先试它，再退回老写法兜底。
 */
function focusWindow (hwnd) {
  if (!hwnd || process.platform !== 'win32') return false
  if (IsIconic(hwnd)) ShowWindow(hwnd, 9) // SW_RESTORE
  ShowWindow(hwnd, 5) // SW_SHOW

  try {
    SwitchToThisWindow(hwnd, true)
  } catch {
    /* 极端情况没有这个导出，交给下面的兜底 */
  }
  if (GetForegroundWindow() === hwnd) return true

  const fg = GetForegroundWindow()
  const fgTid = GetWindowThreadProcessId(fg, null)
  const selfTid = GetWindowThreadProcessId(hwnd, null)
  AttachThreadInput(fgTid, selfTid, true)
  BringWindowToTop(hwnd)
  SetForegroundWindow(hwnd)
  AttachThreadInput(fgTid, selfTid, false)
  return GetForegroundWindow() === hwnd
}

/**
 * 在一段时间内反复把窗口按回前台。
 *
 * 微信加载完小程序后会自己把**主窗口**抬起来（它认为主窗口才是自己的脸），
 * 单次激活会被它盖回去 —— 现场看到的就是「小程序开了，但屏幕上是微信」。
 * 这里盯住前台，被抢了就再抢回来，持续几秒覆盖它那波节奏。
 */
async function holdForeground (hwnd, ms = 4000) {
  const end = Date.now() + ms
  let tries = 0
  while (Date.now() < end && tries < 10) {
    if (GetForegroundWindow() === hwnd) {
      await sleep(300)
      continue
    }
    tries++
    focusWindow(hwnd)
    await sleep(300)
  }
  return GetForegroundWindow() === hwnd
}

/**
 * 把微信主窗口摆到前台。
 *
 * 只该在「小程序没打开」时用：那时谁也没起来，把微信摆到眼前至少能让操作员
 * 立刻发现「没打开」。**小程序打开成功时千万别调这个** —— 主窗口会正好盖住
 * 刚弹出来的小程序窗口。
 */
export function focusWeixin () {
  if (process.platform !== 'win32') return false
  return focusWindow(findMainWindow())
}

/** 用 appid 拼出微信认的那条链接 */
export function appletUrl (appid) {
  const id = String(appid || '').trim()
  if (!/^wx[0-9a-f]{16}$/i.test(id)) return ''
  return `weixin://launchapplet/?app_id=${id}`
}

/**
 * 从一段文本里抠出 appid。
 *
 * 后台「入口」字段常被直接填成 `weixin://launchapplet/?app_id=wx...` —— 那是给
 * 桌面快捷方式用的地址，塞进 <webview> 只会得到一块白屏，所以凡是入口里能认出
 * appid 的，都该走小程序分支而不是 H5 分支。
 *
 * 认得三种写法：裸 appid、launchapplet 链接、任意带 app_id / appid 参数的链接。
 */
export function parseAppid (text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  if (/^wx[0-9a-f]{16}$/i.test(raw)) return raw
  const m =
    raw.match(/[?&]app_?id=(wx[0-9a-f]{16})/i) || raw.match(/\b(wx[0-9a-f]{16})\b/i)
  return m ? m[1] : ''
}

/**
 * 桌面（含公共桌面）上那些小程序快捷方式带的 appid。
 *
 * 「添加到电脑桌面」生成的 .lnk，目标就是 `weixin://launchapplet/?app_id=wx...`，
 * 字符串按 UTF-16LE 存在文件里，直接扫字节就够了，不必解析 .lnk 结构。
 * 用途：后台 appid 抄错/抄少时，拿真实值去纠正文案。
 */
function desktopAppids () {
  const list = []
  const dirs = [
    path.join(os.homedir(), 'Desktop'),
    path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop')
  ]
  for (const dir of dirs) {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const file of names) {
      if (!/\.lnk$/i.test(file)) continue
      try {
        const text = fs.readFileSync(path.join(dir, file)).toString('utf16le')
        const hit = text.match(/app_id=(wx[0-9a-f]{16})/i)
        if (hit) list.push({ appid: hit[1].toLowerCase(), name: file.replace(/\.lnk$/i, '') })
      } catch {
        /* 个别 lnk 读不了不影响整体 */
      }
    }
  }
  return list
}

/**
 * 按 appid 打开小程序。
 *
 * 关键点：`shell.openExternal` 不抛异常 ≠ 小程序起来了。微信对「没登记过桌面」的
 * appid 是静默丢弃，所以这里调用前后各拍一次小程序窗口快照，状态没变化就老老实实
 * 报失败，并告诉操作员缺哪一步。
 *
 * @param {string} appid 小程序 appid（wx + 16 位十六进制）
 * @param {string} name  展示名，用于提示文案
 */
export async function launchMiniapp (appid, name = '') {
  const url = appletUrl(appid)
  const label = name || appid
  if (!url) {
    const raw = String(appid || '').trim()
    if (!raw) {
      return {
        ok: false,
        url: '',
        needsAppid: true,
        message: `没有拿到《${label}》的小程序 appid：后台填好 accessAppId 之后才能一键直达`
      }
    }
    /**
     * 最常见的错法不是「没填」，而是抄少了几位字符 —— 微信不校验、只会静默丢弃，
     * 所以这里主动去桌面快捷方式里找同一个 appid 的完整版本，直接把正确值给出来。
     */
    const lower = raw.toLowerCase()
    const guess = desktopAppids().find(
      (item) => item.appid.startsWith(lower) || lower.startsWith(item.appid)
    )
    return {
      ok: false,
      url: '',
      needsAppid: true,
      message: guess
        ? `accessAppId 少了字符：后台填的是「${raw}」（${raw.length} 位），桌面上《${guess.name}》的快捷方式里是「${guess.appid}」（18 位），改成它就行`
        : `accessAppId 格式不对：后台填的是「${raw}」（${raw.length} 位），正确格式是 wx + 16 位十六进制，共 18 位`
    }
  }
  if (!isWeixinRunning()) {
    return { ok: false, url, message: '微信没有运行，请先登录电脑版微信' }
  }

  const windowsBefore = appletWindows()

  try {
    await shell.openExternal(url)
  } catch (e) {
    return { ok: false, url, message: `调用微信失败：${e.message}` }
  }

  // 小程序窗口标题就是小程序名；名字对不上时还能靠「新窗口 / 前台切过去」认出来
  const wanted = String(name || '').replace(/\s+/g, '')
  const nameMatches = (title) => {
    if (!wanted) return false
    const t = String(title || '').replace(/\s+/g, '')
    return t.includes(wanted) || wanted.includes(t)
  }

  // 微信是异步拉起的，窗口可能几百毫秒才出来：盯着状态变化比固定 sleep 靠谱
  const deadline = Date.now() + 8000
  let opened = false
  let hitHwnd = 0
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    const now = appletWindows()
    const foreground = GetForegroundWindow()
    for (const [hwnd, title] of now) {
      // ① 新开了一个小程序窗口
      // ② 微信把某个小程序窗口切到前台（之前开着的那个）
      // ③ 已经有同名窗口在（微信是复用而不是新建）
      if (!windowsBefore.has(hwnd) || hwnd === foreground || nameMatches(title)) {
        opened = true
        hitHwnd = hwnd
        break
      }
    }
    if (opened) break
  }

  /**
   * 谁该在最上面：小程序窗口。
   *
   * 原来这里无条件 focusWeixin()，把微信主窗口抢到前台，正好盖住刚弹出来的
   * 小程序窗口 —— 现场看到的是「明明打开了，屏幕上只有微信」。
   * 现在只在失败时拉主窗口（提醒操作员没打开），成功就激活小程序窗口本身。
   */
  if (opened && hitHwnd) {
    // 小程序窗口才该在最上面：只按一次会被微信「抬主窗口」盖回去，得盯几秒
    await holdForeground(hitHwnd)
  } else if (!opened) {
    focusWeixin()
  }

  if (!opened) {
    return {
      ok: false,
      url,
      needsAddToDesktop: true,
      message:
        `微信没接住这条链接：《${label}》还没「添加到电脑桌面」过。` +
        `在微信里打开它 → 右上角「⋯」→ 添加到电脑桌面，之后再点一次就行（只需一次）`
    }
  }

  return { ok: true, url, message: `已通过 appid 打开《${label}》` }
}

/**
 * 不走 scheme，改用「微信搜索框」把小程打开。
 *
 * 为什么需要这条：`launchapplet` 只对该小程序「添加到电脑桌面」过之后才生效，
 * 影城上百家、小程序又不是我们的，没法批量登记。实测 5 种 weixin:// 写法
 * （app_id / appid / 带 path / dl/business / dl/business?t=）在未登记时**全部无响应**，
 * scheme 层面绕不过去，只剩「让微信自己走一遍搜索」这条路。
 *
 * 代价：这是界面自动化 —— 要求微信在前台、剪贴板可用、搜索首条结果就是目标小程序。
 * 所以只作为显式动作暴露（按钮触发），绝不自动执行。
 */
export async function launchBySearch (name) {
  if (process.platform !== 'win32') return { ok: false, message: '只支持 Windows' }
  const keyword = String(name || '').trim()
  if (!keyword) return { ok: false, message: '没有小程序名，无法搜索' }
  if (!isWeixinRunning()) return { ok: false, message: '微信没有运行，请先登录电脑版微信' }

  const before = appletWindows()
  const main = findMainWindow()
  if (!main) return { ok: false, message: '没找到微信主窗口' }
  if (!focusWindow(main)) {
    return {
      ok: false,
      code: 'no-foreground',
      message: '微信没能切到前台（Windows 前台锁），先点一下微信窗口再重试'
    }
  }

  const backup = clipboard.readText()
  try {
    clipboard.writeText(keyword)
    await sleep(200)
    ctrlKey(VK.F) // 聚焦搜索框
    await sleep(900)
    ctrlKey(VK.V) // 粘关键词
    await sleep(1500)
    tapKey(VK.ENTER) // 进第一个结果
  } finally {
    // 剪贴板是共享资源，用完还回去
    try {
      clipboard.writeText(backup)
    } catch {
      /* 还原失败不影响主流程 */
    }
  }

  const wanted = keyword.replace(/\s+/g, '')
  const deadline = Date.now() + 12000
  let hit = null
  while (Date.now() < deadline && !hit) {
    await sleep(400)
    for (const [hwnd, title] of appletWindows()) {
      if (!before.has(hwnd)) {
        hit = { hwnd, title }
        break
      }
    }
  }

  if (!hit) {
    tapKey(VK.ESC) // 把搜索面板收掉，别留在前台
    return {
      ok: false,
      message: `搜索「${keyword}」后没有打开小程序：确认微信在前台、这个名字能搜到`
    }
  }

  await holdForeground(hit.hwnd)
  const title = String(hit.title).replace(/\s+/g, '')
  const matched = title.includes(wanted) || wanted.includes(title)
  return {
    ok: true,
    via: 'search',
    title: hit.title,
    message: matched
      ? `已用搜索打开《${hit.title}》（没走桌面快捷方式）`
      : `已打开《${hit.title}》，但和名字「${keyword}」对不上，确认搜到的是同一家`
  }
}

export default {
  launchMiniapp,
  launchBySearch,
  appletUrl,
  parseAppid,
  focusWeixin,
  isWeixinRunning
}
