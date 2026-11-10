export default class EventRouter {
  #api = {}
  #routers
  /**
   * api：elctron api 模块
   * routers：路由事件函数
   */
  constructor(api, routers = []) {
    this.routers = routers
  }
  addRoute(route) {
    this.routers.push(route)
  }
  addRoutes(routes) {
    this.routers.push(...routes)
  }
  removeRoute(name) {
    const index = this.routers.findIndex(route => route.name === name)
    if (index > -1) {
      this.routers.splice(index, 1)
    }
  }
  router(data) {
    const route = this.routers.find(route => route.name === data.name)
    if(route && route.callback) {
      return route.callback(this.#api, data)
      // const callbackResult = route.callback(this.#api, data)
      // console.log("callbackResult", callbackResult)
      // if (callbackResult instanceof Promise) {
      //   return await callbackResult
      // } else {
      //   return callbackResult
      // }
    }
  }
  addApi(key, api) {
    this.#api[key] = api
  }
}