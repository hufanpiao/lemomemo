// 职责：“今天”视图的总装：下一件事大卡片（整张可点；到了提醒时间进入提醒状态，见 ui/remind.js）、今天要做、晚上预告明天；
//       每次重绘先让 ui/remind.js 更新提醒，再画抬头下方的反色提醒卡片。没赶上面板和时间轴分别在
//       ui/today-late.js、ui/today-timeline.js 里，这里按顺序调用。
// 依赖：core/const.js、core/date.js、logic/items.js、logic/projects.js、logic/sort.js、logic/format.js、
//       data/state.js、ui/dom.js、ui/today-late.js、ui/today-timeline.js
// 运行时调用：ui/sheet.js、ui/todos.js、ui/schedule.js、ui/remind.js、App.clock
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

// 整张卡都能点开编辑（PM-A⑩）；卡片里的按钮自己阻止冒泡
function cardOpen(card, kind, item){
  card.tabIndex = 0; card.setAttribute("role", "button");
  card.setAttribute("aria-label", (kind === "event" ? "编辑日程：" : "编辑待办：") + item.title);
  card.onclick = () => openSheet(kind, item);
  card.onkeydown = ev => { if (ev.target === card && (ev.key === "Enter" || ev.key === " ")){ ev.preventDefault(); openSheet(kind, item); } };
  return card;
}
// 返回被画成提醒状态的那一条 {kind, id}（情况 A），没有就返回 null
function renderNext(t, nm){
  const box = $("next"); box.textContent = "";
  if (!ready()){ box.append(h("div",{class:"next empty"}, ...skeleton(2))); return null; }
  const n = pickNext(visEv(), visTd(), t, nm);
  if (!n){
    const nothing = !visEv().length && !visTd().length;
    box.append(h("div",{class:"next empty"}, h("span",{class:"lbl"},"下一件事"), h("span",{class:"big"},"空闲"),
      h("span",{class:"cd"}, nothing
        ? "还没有安排。点右下角的＋写一句话就能记下，也可以在聊天里跟 Claude 说“帮我记一下……”。"
        : "今天没有别的安排了。点右下角的＋记一件新的事。")));
    return null;
  }
  const kind = n.kind, x = n.item;
  const rem = App.ui.remind.todayVisible() ? App.ui.remind.decorateNext(kind, x) : null;
  let card;
  if (kind === "event"){
    card = h("div",{class:"next",style:"background:"+projColor(x.project)},
      rem ? h("div",{class:"rem-extra"}, h("div",null, rem.bell)) : h("span",{class:"lbl"},"下一件事"), h("span",{class:"big"},x.time),
      rem ? null : h("span",{class:"cd"},startsText(n.start - nm, n.end)),
      h("span",{class:"tt"},x.title), x.project || x.note ? h("span",{class:"proj"},[x.project,x.note].filter(Boolean).join("  ")) : null,
      rem ? h("div",{class:"rem-extra"}, h("div",null, rem.acts)) : null);
  } else {
    card = h("div",{class:"next",style:"background:"+projColor(x.project)},
      rem ? h("div",{class:"rem-extra"}, h("div",null, rem.bell)) : h("span",{class:"lbl"},"下一件事"),
      h("span",{class:"big",style:"font-size:40px"}, x.due ? dueText(x.due, t).replace("截止","") : (x.important ? "重要" : "待办")),
      h("span",{class:"tt"},x.title), x.project ? h("span",{class:"proj"},x.project) : null,
      rem ? h("div",{class:"rem-extra"}, h("div",null, rem.acts)) : h("button",{class:"act",type:"button","aria-label":"完成："+x.title,html:ICON_CHECK,onclick:ev=>{ ev.stopPropagation(); App.ui.todos.toggle(x,true); }}));
  }
  if (rem){
    // 提醒状态：卡片本身不当按钮用（按钮不能嵌在按钮里，D18），改成标题可点；新出现时用隐藏文字播报一次
    card.classList.add("reminding"); if (rem.isNew) card.classList.add("enter"); if (rem.confirmed) card.classList.add("confirmed");
    const tt = card.querySelector(".tt");
    const open = h("button",{type:"button",class:"tt tt-btn","aria-label":(kind === "event" ? "编辑日程：" : "编辑待办：") + x.title,onclick:()=>openSheet(kind, x)}, x.title);
    tt.replaceWith(open);
    if (rem.announce) card.append(h("span",{class:"sr-only",role:"alert"}, rem.announce));
    box.append(card);
  } else box.append(cardOpen(card, kind, x));
  return rem ? {kind, id:x.id} : null;
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
    ul.append(h("li",null, emptyBox(anyOpen ? "最近两天没有到期的事" : "没有待办", anyOpen ? "其他待办在“全部待办”里。" : "点右下角的＋，写一句话就能记下；也可以在聊天里让 Claude 代记。")));
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
  App.ui.remind.update();
  const shownInNext = renderNext(t, nm);
  App.ui.remind.renderCard(shownInNext);
  App.ui.todayLate.render(t);
  App.ui.todayTimeline.render(t, nm);
  renderTodayTodos(t);
  renderTomorrow(t);
}

App.ui.today = {render: renderToday};
