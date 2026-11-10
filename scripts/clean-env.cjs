#!/usr/bin/env node
/**
 * 启动包装器：在拉起 electron-vite / electron 之前，剥离宿主注入的
 * ELECTRON_RUN_AS_NODE。
 *
 * 背景：
 *   VS Code / Cursor / WorkBuddy 这类「本身是 Electron 应用」的宿主，
 *   给内置终端注入 ELECTRON_RUN_AS_NODE=1。子进程一旦继承到它，
 *   electron.exe 就会退化成纯 Node 解释器去执行 out/main/index.js，
 *   在 import '@electron-toolkit/utils' 时抛出
 *   TypeError: Cannot read properties of undefined (reading 'isPackaged')
 *   然后立刻退出 —— 表现就是「构建成功、窗口闪一下就关」。
 *
 * 注意：
 *   置空（ELECTRON_RUN_AS_NODE=）是无效的。Electron 只判断变量
 *   是否存在，实测置空后 --version 打印的是 Node 版本（v20.18.0）。
 *   必须用 delete 从环境里真正删除。
 */
const { spawn } = require('node:child_process')

const STRIP_KEYS = ['ELECTRON_RUN_AS_NODE']

const removed = []
for (const key of STRIP_KEYS) {
  if (key in process.env) {
    removed.push(`${key}=${process.env[key]}`)
    delete process.env[key]
  }
}

if (removed.length) {
  console.log(`[clean-env] 已移除宿主注入的环境变量：${removed.join(', ')}`)
}

const [command, ...args] = process.argv.slice(2)

if (!command) {
  console.error('[clean-env] 用法：node scripts/clean-env.cjs <命令> [参数...]')
  process.exit(1)
}

const isWin = process.platform === 'win32'

const child = spawn(command, args, {
  stdio: 'inherit',
  // Windows 下 electron-vite 是 node_modules/.bin 里的 .cmd，需要 shell 解析
  shell: isWin,
  env: process.env
})

child.on('error', (err) => {
  console.error(`[clean-env] 启动 ${command} 失败：${err.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code === null ? 1 : code)
})
