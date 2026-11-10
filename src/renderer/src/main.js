import { createApp } from 'vue'
import ElementPlus from 'element-plus'
// element-plus 的样式必须先于 main.css 导入，否则我们的变量覆盖会被它盖回去
import 'element-plus/dist/index.css'
import 'uno.css'
import './assets/main.css'
import router from '@router'
import App from './App.vue'

const app = createApp(App)

app.use(ElementPlus)
app.use(router)
app.mount('#app')
