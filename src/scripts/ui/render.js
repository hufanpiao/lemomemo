// 职责：渲染调度与数据事件的接线：订阅 data 层的 change / error / notice，决定重绘和提示；
//       render() 依次重绘抬头、今天、日程、待办（勾选动画期间暂缓）；抬头显示月日、星期年份和“今天完成 / 没赶上”胶囊。
// 依赖：core/const.js、core/date.js、logic/items.js、data/bus.js、data/state.js、ui/dom.js、ui/view-state.js、ui/toast.js
// 运行时调用：ui/today.js、ui/schedule.js、ui/todos.js、ui/nav.js、App.clock
App.ui = App.ui || {};

const C = App.core.C;
const {WK, parse} = App.core.date;
const {isDoneOn, isLate} = App.logic.items;
const {$, h} = App.ui.dom;
const V = App.ui.view, toast = App.ui.toast, visTd = App.data.visTd;

const ERR_TEXT = {forbidden:"你没有修改权限，只能查看。", quota:"存储已满，删掉一些旧条目再试。"};
const errText = code => ERR_TEXT[code] || "没保存上，检查网络后再试。";

function render(){
  const wait = V.holdUntil - App.clock.now();
  if (wait > 0){ clearTimeout(V.holdTimer); V.holdTimer = setTimeout(render, wait + 10); return; }
  renderHead(); App.ui.today.render(); App.ui.schedule.render(); App.ui.todos.render();
}

function renderHead(){
  const t = App.clock.today(), d = parse(t);
  $("hd-md").innerHTML = ""; $("hd-md").append((d.getMonth()+1)+"", h("small",null,"月"), d.getDate()+"", h("small",null,"日"));
  $("hd-sub").textContent = WK[d.getDay()] + "  " + d.getFullYear() + "年";
  const chips = $("hd-chips"); chips.textContent = "";
  const doneToday = visTd().filter(x => isDoneOn(x, t)).length;
  const late = visTd().filter(x => isLate(x, t)).length;
  if (doneToday) chips.append(h("span",{class:"chip"},"今天完成 ",h("b",null,doneToday)," 件"));
  if (late) chips.append(h("button",{class:"chip late",type:"button",onclick:()=>{ App.ui.nav.go("today"); $("late").scrollIntoView({behavior:"smooth",block:"center"}); }},h("b",null,late)," 件没赶上"));
}

function showNoData(hint){
  const n = $("notice"); n.hidden = false; n.textContent = "";
  n.append(h("strong",null,hint.title), hint.text);
}

function init(){
  App.data.on("change", render);
  App.data.on("error", e => { V.holdUntil = 0; toast.show(errText(e.code), "重试", e.retry, C.TOAST_RETRY_MS); });
  App.data.on("notice", n => {
    if (n.type === "unavailable") showNoData(n.hint);
    else if (n.type === "lost") toast.show("和云端的连接断了，刷新页面即可恢复", "刷新", () => location.reload(), C.TOAST_LOST_MS);
  });
}

render.head = renderHead;
render.init = init;
render.errText = errText;
App.ui.render = render;
