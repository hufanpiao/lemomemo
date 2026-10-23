// 职责：“今天”视图的总装：下一件事大卡片、今天要做、晚上预告明天；没赶上面板和时间轴分别在
//       ui/today-late.js、ui/today-timeline.js 里，这里按顺序调用。
// 依赖：core/const.js、core/date.js、logic/items.js、logic/projects.js、logic/sort.js、logic/format.js、
//       data/state.js、ui/dom.js、ui/today-late.js、ui/today-timeline.js
// 运行时调用：ui/sheet.js、ui/todos.js、ui/schedule.js、App.clock
App.ui = App.ui || {};

const C = App.core.C;
const {addDays} = App.core.date;
const {isDoneOn} = App.logic.items;
const {projColor} = App.logic.projects;
const {byTime, sortTodos, pickNext} = App.logic.sort;
const {relDay, dueText, startsText} = App.logic.format;
const visEv = App.data.visEv, visTd = App.data.visTd, ready = App.data.ready;
const {$, h, ICON_CHECK, skeleton, emptyBox} = App.ui.dom;
const openSheet = (...a) => App.ui.sheet.open(...a);
const todoRow = x => App.ui.todos.row(x);
const evBlock = e => App.ui.schedule.evBlock(e);

function renderNext(t, nm){
  const box = $("next"); box.textContent = "";
  if (!ready()){ box.append(h("div",{class:"next empty"}, ...skeleton(2))); return; }
  const n = pickNext(visEv(), visTd(), t, nm);
  if (!n){
    box.append(h("div",{class:"next empty"}, h("span",{class:"lbl"},"下一件事"), h("span",{class:"big"},"空闲"),
      h("span",{class:"cd"},"今天没有别的安排了。点右下角的＋记一件新的事。")));
  } else if (n.kind === "event"){
    const e = n.item;
    box.append(h("button",{class:"next",type:"button",style:"background:"+projColor(e.project)+";border:0;text-align:left;width:100%",onclick:()=>openSheet("event",e)},
      h("span",{class:"lbl"},"下一件事"), h("span",{class:"big"},e.time), h("span",{class:"cd"},startsText(n.start - nm, n.end)),
      h("span",{class:"tt"},e.title), e.project || e.note ? h("span",{class:"proj"},[e.project,e.note].filter(Boolean).join("  ")) : null));
  } else {
    const x = n.item;
    const card = h("div",{class:"next",style:"background:"+projColor(x.project)},
      h("span",{class:"lbl"},"下一件事"), h("span",{class:"big",style:"font-size:40px"}, x.due ? dueText(x.due, t).replace("截止","") : "待办"),
      h("span",{class:"tt"},x.title), x.project ? h("span",{class:"proj"},x.project) : null,
      h("button",{class:"act",type:"button","aria-label":"完成："+x.title,html:ICON_CHECK,onclick:()=>App.ui.todos.toggle(x,true)}));
    card.querySelector(".tt").onclick = () => openSheet("todo", x);
    box.append(card);
  }
}

function renderTodayTodos(t){
  const ul = $("today-todos"); ul.textContent = "";
  if (!ready()){ ul.append(...skeleton(2)); return; }
  const soon = addDays(t, C.SOON_DAYS);
  const list = visTd().filter(x => (!x.done && (!x.due || x.due >= t) && ((x.due && x.due <= soon) || x.important)) ||
    (isDoneOn(x, t) && (x.important || (x.due && x.due <= soon))));
  sortTodos(list);
  if (!list.length){
    const anyOpen = visTd().some(x => !x.done);
    ul.append(h("li",null, emptyBox(anyOpen ? "最近两天没有到期的事" : "没有待办", anyOpen ? "其他待办在“全部待办”里。" : "点右下角的＋，写一句话就能记下。")));
  } else list.forEach(x => ul.append(todoRow(x)));
}

function renderTomorrow(t){
  const tm = $("tomorrow");
  const showTm = App.clock.hour() >= C.TOMORROW_PREVIEW_HOUR;
  tm.hidden = !showTm || !ready();
  if (!showTm || !ready()) return;
  const tmr = addDays(t,1);
  const evs = visEv().filter(e => e.date === tmr).sort(byTime);
  $("tm-meta").textContent = relDay(tmr, t);
  const l = $("tm-list"); l.textContent = "";
  if (!evs.length) l.append(emptyBox("明天还没有安排", "可以早点休息。"));
  else evs.forEach(e => l.append(evBlock(e)));
}

function renderToday(){
  const t = App.clock.today(), nm = App.clock.nowMin();
  renderNext(t, nm);
  App.ui.todayLate.render(t);
  App.ui.todayTimeline.render(t, nm);
  renderTodayTodos(t);
  renderTomorrow(t);
}

App.ui.today = {render: renderToday};
