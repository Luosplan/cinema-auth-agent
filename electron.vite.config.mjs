import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

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
    plugins: [
      vue({
        template: {
          compilerOptions: {
            // <webview> 是 Electron 提供的原生标签，不是 Vue 组件；
            // 不声明会被当成未知自定义元素，白名单里过一遍才不报警告
            isCustomElement: (tag) => tag === 'webview'
          }
        }
      }),
      UnoCSS()
    ],
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
