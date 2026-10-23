// 职责：底部导航与网络提示：go() 切换今天 / 日程 / 待办三页并回到页顶（记住上次的页、移动白色指示块、窄屏只显示当前页文字）；
//       窗口尺寸变化时只重排导航、不滚动（修 v2“resize 跳回顶部”）；断网时顶部显示红条。
// 依赖：core/const.js、platform/prefs.js、ui/dom.js、ui/view-state.js
App.ui = App.ui || {};

const C = App.core.C;
const prefs = App.platform.prefs;
const {$} = App.ui.dom;
const V = App.ui.view;

function placeInd(){
  const b = document.querySelector('#nav button[data-go="'+V.view+'"]'); if (!b) return;
  $("ind").style.left = b.offsetLeft+"px"; $("ind").style.width = b.offsetWidth+"px";
}
// 显示 v 这一页（不滚动）
function applyView(v){
  V.view = v; prefs.set(prefs.KEYS.view, v);
  document.querySelectorAll(".view").forEach(el => el.classList.toggle("on", el.dataset.view === v));
  document.querySelectorAll("#nav button").forEach(b => {
    const on = b.dataset.go === v;
    b.setAttribute("aria-current", on ? "page" : "false");
    const lab = b.querySelector(".lab");
    b.setAttribute("aria-label", lab.textContent);   // 窄屏隐藏文字时，读屏仍能读出按钮名（PM-C⑩）
    lab.hidden = !on && innerWidth < C.NARROW_NAV_PX;
  });
  requestAnimationFrame(placeInd);
}
function go(v){ applyView(v); window.scrollTo({top:0}); }
const net = () => { $("netbar").hidden = navigator.onLine !== false; };
function init(){
  document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go(b.dataset.go)));
  addEventListener("resize", () => applyView(V.view));
}
function initNet(){
  addEventListener("online", net); addEventListener("offline", net); net();
}

App.ui.nav = {go, applyView, placeInd, init, initNet};
