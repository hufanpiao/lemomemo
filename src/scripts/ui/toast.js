// 职责：底部提示条队列：show(文案, 按钮字, 按钮动作, 显示毫秒) 新增一条，可叠放，最多 TOAST_MAX 条（超出时最早的先走），
//       每条有自己的计时器；带按钮的“撤销”类提示由调用方传 TOAST_UNDO_MS。点按钮执行动作并收起这一条。
// 依赖：core/const.js、ui/dom.js
App.ui = App.ui || {};

const C = App.core.C;
const {$, h} = App.ui.dom;
const live = [];   // 当前显示中的提示：{el, timer}

function dismiss(t){
  const i = live.indexOf(t); if (i < 0) return;
  live.splice(i, 1);
  clearTimeout(t.timer);
  t.el.classList.remove("on");
  setTimeout(() => t.el.remove(), C.TOAST_LEAVE_MS);
}
function show(msg, btnText, action, ms){
  while (live.length >= C.TOAST_MAX) dismiss(live[0]);
  const t = {el:null, timer:null};
  const btn = btnText ? h("button",{type:"button",onclick:() => { dismiss(t); if (action) action(); }}, btnText) : null;
  t.el = h("div",{class:"toast"}, h("span",null,msg), btn);
  $("toasts").append(t.el);
  live.push(t);
  requestAnimationFrame(() => t.el.classList.add("on"));
  t.timer = setTimeout(() => dismiss(t), ms || C.TOAST_MS);
  return t;
}

App.ui.toast = {show, dismiss};
