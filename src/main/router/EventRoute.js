export default class EventRoute {
  #name;
  #event;
  #callback;
   /**
   * name: 事件名称
   * event: 事件对象
   * callback: 事件回调函数
   */
  constructor(name, event, callback) {
    this.name = name;
    this.event = event;
    this.callback = callback;
  }
}