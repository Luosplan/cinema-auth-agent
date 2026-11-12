/**
 * 只剩一个页面：影城账号。
 *
 * 设置从独立页面改成了弹窗（由标题栏的齿轮唤起），路由表里就不该再有第二项。
 * 旧路径全部重定向回主页面，避免本地缓存的 lastRoute 或外部链接落到空白。
 */
const routes = [
  { path: '/', redirect: '/cinemas' },
  {
    path: '/cinemas',
    name: 'Cinemas',
    component: () => import('@views/cinemas.vue'),
    meta: { title: '影城账号' }
  },
  { path: '/settings', redirect: '/cinemas' },
  { path: '/dashboard', redirect: '/cinemas' },
  { path: '/logs', redirect: '/cinemas' },
  { path: '/:pathMatch(.*)*', redirect: '/cinemas' }
]

export default routes
