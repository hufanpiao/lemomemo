// 底部导航与网络提示：go() 切换今天 / 日程 / 待办三页（记住上次的页、移动白色指示块、窄屏只显示当前页文字），
// 断网时顶部显示红条。
// 依赖：core/dom.js、data/state.js。
App.ui = App.ui || {};

const {$} = App.core.dom;
const S = App.data.state;

function placeInd(){
  const b = document.querySelector('#nav button[data-go="'+S.view+'"]'); if (!b) return;
  $("ind").style.left = b.offsetLeft+"px"; $("ind").style.width = b.offsetWidth+"px";
}
function go(v){
  S.view = v; try { localStorage.setItem("pv-view", v); } catch(e){}
  document.querySelectorAll(".view").forEach(el => el.classList.toggle("on", el.dataset.view === v));
  document.querySelectorAll("#nav button").forEach(b => {
    const on = b.dataset.go === v;
    b.setAttribute("aria-current", on ? "page" : "false");
    b.querySelector(".lab").hidden = !on && innerWidth < 380;
  });
  requestAnimationFrame(placeInd);
  window.scrollTo({top:0});
}
const net = () => { $("netbar").hidden = navigator.onLine !== false; };
function init(){
  document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go(b.dataset.go)));
  addEventListener("resize", () => { go(S.view); });
}
function initNet(){
  addEventListener("online", net); addEventListener("offline", net); net();
}

App.ui.nav = {go, placeInd, init, initNet};
