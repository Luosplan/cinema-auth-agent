import { resolve } from 'path'
import { mkdirSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

// 本机杀软会锁住 %TEMP% 下 esbuild 的中间文件（remove ... Access is denied），
// 把 esbuild 的临时目录重定向到项目内 .tmp（已 gitignore + 已排除出打包）。
if (process.platform === 'win32') {
  const esbuildTmp = resolve('.tmp')
  mkdirSync(esbuildTmp, { recursive: true })
  process.env.TMP = esbuildTmp
  process.env.TEMP = esbuildTmp
  process.env.TMPDIR = esbuildTmp
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@router': resolve('src/renderer/src/router'),
        '@views': resolve('src/renderer/src/views'),
        '@utils': resolve('src/renderer/src/utils')
      },
      extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue']
    },
    plugins: [vue(), UnoCSS()],
    css: {
      preprocessorOptions: {
        scss: {
          // 设置为现代 API
          api: 'modern'
        }
      }
    }
  }
})
