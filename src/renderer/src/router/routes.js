const routes = [
  {
    path: '/',
    redirect: '/dashboard'
  },
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: () => import('@views/dashboard.vue'),
    meta: { title: '概览' }
  },
  {
    path: '/cinemas',
    name: 'Cinemas',
    component: () => import('@views/cinemas.vue'),
    meta: { title: '影城账号' }
  },
  {
    path: '/systems',
    name: 'Systems',
    component: () => import('@views/systems.vue'),
    meta: { title: '影城配置' }
  },
  {
    path: '/logs',
    name: 'Logs',
    component: () => import('@views/logs.vue'),
    meta: { title: '抓包日志' }
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('@views/settings.vue'),
    meta: { title: '设置' }
  }
]

export default routes
