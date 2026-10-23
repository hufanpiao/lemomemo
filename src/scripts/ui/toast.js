// 底部提示条：show(文案, 按钮字, 按钮动作, 显示毫秒)，默认 3 秒后自动消失；按钮用于撤销 / 重试 / 刷新。
// 依赖：core/dom.js。
App.ui = App.ui || {};

const {$} = App.core.dom;
let toastTimer = null, toastAction = null;

function show(msg, btnText, action, ms){
  $("toast-msg").textContent = msg;
  const b = $("toast-btn"); b.hidden = !btnText; b.textContent = btnText || "";
  toastAction = action || null;
  $("toast").classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").classList.remove("on"), ms || 3000);
}
function init(){
  $("toast-btn").onclick = () => { const a = toastAction; toastAction = null; $("toast").classList.remove("on"); if (a) a(); };
}

App.ui.toast = {show, init};
