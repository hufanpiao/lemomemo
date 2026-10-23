// 职责：数据层的事件总线。data 层只发事件，不碰界面；界面用 App.data.on() 订阅后自己决定重绘或提示。
//       事件："change"（数据或加载状态变了，该重绘）、"error" {code, retry}（写入失败，已回滚）、
//             "notice" {type:"unavailable", hint} | {type:"lost"} | {type:"reconnected"}（连接状态）。
// 依赖：无
App.data = App.data || {};

const subs = {};
App.data.on = function on(type, fn){
  (subs[type] = subs[type] || []).push(fn);
  return () => { subs[type] = subs[type].filter(f => f !== fn); };
};
App.data.emit = function emit(type, payload){
  (subs[type] || []).slice().forEach(fn => fn(payload));
};
