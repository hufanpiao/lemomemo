// 职责：渲染调度与数据事件的接线：订阅 data 层的 change / error / notice（连不上、断线自动重连中、已重新连上），决定重绘和提示；
//       render() 依次重绘抬头、今天、日程、待办（勾选动画期间暂缓），重绘后把键盘焦点找回原来的位置；抬头显示月日、星期年份和“今天完成 / 没赶上”胶囊。
// 依赖：core/const.js、core/date.js、logic/items.js、data/bus.js、data/state.js、ui/dom.js、ui/view-state.js、ui/toast.js
// 运行时调用：ui/today.js、ui/schedule.js、ui/todos.js、ui/nav.js、App.clock
App.ui = App.ui || {};

const C = App.core.C;
const {WK, parse} = App.core.date;
const {isDoneOn, isLate} = App.logic.items;
const {$, h} = App.ui.dom;
const V = App.ui.view, toast = App.ui.toast, visTd = App.data.visTd;

const ERR_TEXT = {forbidden:"你没有修改权限，只能查看。", quota:"存储已满，删掉一些旧条目再试。",
  not_found:"没保存上：这条可能已经在别的设备上删除了。", timeout:"没保存上：网络太慢，检查网络后再试。"};
const errText = code => ERR_TEXT[code] || "没保存上，检查网络后再试。";

// 重绘会重建列表，焦点会丢到 body；重绘前记下焦点在哪个元素上，重绘后找回同一个位置（PM-C⑦、TC-A11Y）
function focusKey(){
  const a = document.activeElement;
  if (!a || a === document.body || $("sheet").contains(a)) return null;
  const host = a.closest("[data-id]");
  return {el:a, id:a.id || null, dataId: host ? host.dataset.id : null, cls: (a.className || "").split(" ")[0], label: a.getAttribute("aria-label")};
}
function restoreFocus(k){
  if (!k || document.contains(k.el)) return;
  let el = null;
  if (k.id) el = $(k.id);
  if (!el && k.dataId) el = document.querySelector('[data-id="' + CSS.escape(k.dataId) + '"] .' + CSS.escape(k.cls || "x"));
  if (!el && k.label) el = [...document.querySelectorAll("[aria-label]")].find(x => x.getAttribute("aria-label") === k.label);
  if (el && el.focus) el.focus({preventScroll:true});
}
function render(){
  const wait = V.holdUntil - App.clock.now();
  if (wait > 0){ clearTimeout(V.holdTimer); V.holdTimer = setTimeout(render, wait + 10); return; }
  const k = focusKey();
  renderHead(); App.ui.today.render(); App.ui.schedule.render(); App.ui.todos.render();
  restoreFocus(k);
}

function renderHead(){
  const t = App.clock.today(), d = parse(t);
  $("hd-md").innerHTML = ""; $("hd-md").append((d.getMonth()+1)+"", h("small",null,"月"), d.getDate()+"", h("small",null,"日"));
  $("hd-sub").textContent = WK[d.getDay()] + "  " + d.getFullYear() + "年";
  const chips = $("hd-chips"); chips.textContent = "";
  const doneToday = visTd().filter(x => isDoneOn(x, t)).length;
  const late = visTd().filter(x => isLate(x, t)).length;
  // “没赶上”排在前面，紧贴日期下方（采纳结论 #2）
  if (late) chips.append(h("button",{class:"chip late",type:"button",onclick:()=>{ App.ui.nav.go("today"); $("late").scrollIntoView({behavior:"smooth",block:"center"}); }},h("b",null,late)," 件没赶上"));
  if (doneToday) chips.append(h("span",{class:"chip"},"今天完成 ",h("b",null,doneToday)," 件"));
}

function showNoData(hint){
  const n = $("notice"); n.hidden = false; n.textContent = "";
  n.append(h("strong",null,hint.title), hint.text);
}

function init(){
  App.data.on("change", render);
  // D10：带“重试”的失败提示不自动消失（时长传 0）；条目已在别处删除时没有可重试的，普通提示即可
  App.data.on("error", e => {
    V.holdUntil = 0;
    const gone = e.code === "not_found";
    toast.show(errText(e.code), gone ? null : "重试", gone ? null : e.retry, gone ? C.TOAST_MS : 0);
  });
  let lostToast = null;   // 断线提示：重新连上时收起
  App.data.on("notice", n => {
    if (n.type === "unavailable") showNoData(n.hint);
    else if (n.type === "lost"){
      if (lostToast) toast.dismiss(lostToast);
      lostToast = toast.show("和云端的连接断了，正在自动重连…", null, null, C.TOAST_LOST_MS);
    } else if (n.type === "reconnected"){
      if (lostToast){ toast.dismiss(lostToast); lostToast = null; }
      toast.show("已重新连上");
    }
  });
}

render.head = renderHead;
render.init = init;
render.errText = errText;
App.ui.render = render;
