#!/usr/bin/env node
/**
 * 把 node_modules/electron/dist 换成指向工作区外二进制的「目录联接」。
 *
 * 为什么需要：
 *   本机（联想安全 / 火绒一类）会拦截位于 D:\zm\smart-bid-system\ 这棵树下的
 *   electron.exe —— 进程秒退，退出码 3，没有任何 Chromium 日志，事件日志也干净。
 *   同一份二进制放到工作区外就能正常跑。electron-vite 启动 electron 用的是
 *   node_modules/electron/dist 里的可执行文件，所以只要把 dist 做成指向外部
 *   目录的 junction，进程的真实镜像路径就在工作区外，拦截不再命中。
 *
 * 默认外部目录：D:\zm\electron-bin（可用 CINEMA_ELECTRON_BIN 覆盖）
 * 重新安装依赖后 junction 会丢，重跑一次 `npm run fix:electron` 即可。
 */
const { spawnSync } = require('node:child_process')
const { existsSync, lstatSync, mkdirSync, cpSync, rmSync, readFileSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.dirname(__dirname)
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist')
const BIN = process.env.CINEMA_ELECTRON_BIN || 'D:\\zm\\electron-bin'

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function latestInstalledVersion() {
  try {
    const v = readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')
    return JSON.parse(v).version
  } catch {
    return ''
  }
}

function main() {
  if (process.platform !== 'win32') {
    console.log('[fix:electron] 仅 Windows 需要，跳过')
    return
  }

  if (!existsSync(path.join(ROOT, 'node_modules', 'electron'))) {
    console.error('[fix:electron] 找不到 node_modules/electron，请先 npm install')
    process.exit(1)
  }

  if (isLink(DIST)) {
    console.log(`[fix:electron] 已经是联接：${DIST} → ${BIN}`)
    return
  }

  // 1) 外部目录还没有二进制 → 从当前 dist 复制一份出去
  if (!existsSync(path.join(BIN, 'electron.exe'))) {
    if (!existsSync(DIST)) {
      console.error('[fix:electron] node_modules/electron/dist 不存在，请先 npm install')
      process.exit(1)
    }
    mkdirSync(BIN, { recursive: true })
    console.log(`[fix:electron] 复制二进制到 ${BIN} …`)
    cpSync(DIST, BIN, { recursive: true })
  }

  const version = latestInstalledVersion()
  console.log(`[fix:electron] electron ${version}，外部目录 ${BIN}`)

  // 2) 删掉本地 dist，换成 junction
  rmSync(DIST, { recursive: true, force: true })
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', DIST, BIN], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.error('[fix:electron] 创建联接失败：', (r.stderr || r.stdout || '').trim())
    process.exit(1)
  }

  if (!existsSync(path.join(DIST, 'electron.exe'))) {
    console.error('[fix:electron] 联接创建后仍找不到 electron.exe')
    process.exit(1)
  }
  console.log('[fix:electron] 完成：node_modules/electron/dist 已指向工作区外的二进制')
}

main()
