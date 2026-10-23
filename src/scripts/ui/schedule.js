// 职责：“日程”视图：一周日期条（圆点＝有日程，墨色短横线＝有待办截止）、翻到别的周时周条下方出现“回到今天”
//       （点标题也能回到今天；翻周时保持星期几）、周条下的项目筛选（与待办页共用）、选中那天的日程和截止的待办
//       （截止行可以直接勾掉）、“接下来”按日期分组的日程；evBlock() 生成一个日程色块（带铃铛标签），今天视图预告明天和搜索结果也用。
// 依赖：core/const.js、core/date.js、logic/items.js、logic/projects.js、logic/sort.js、logic/format.js、
//       data/state.js、ui/dom.js、ui/view-state.js、ui/filter.js
// 运行时调用：ui/sheet.js、ui/todos.js、App.clock
App.ui = App.ui || {};

const C = App.core.C;
const {WK, parse, addDays, m2hm, mondayOf} = App.core.date;
const {endMin} = App.logic.items;
const {projColor} = App.logic.projects;
const {byTime} = App.logic.sort;
const {relDay} = App.logic.format;
const S = App.data.state, visEv = App.data.visEv, visTd = App.data.visTd, ready = App.data.ready;
const {$, h, ICON_CHECK, skeleton, emptyBox} = App.ui.dom;
const V = App.ui.view, filter = App.ui.filter;
const openSheet = (...a) => App.ui.sheet.open(...a);

// opts：{q 高亮关键词, showDate 在说明行前加日期（搜索结果用）}
function evBlock(e, opts){
  const o = opts || {}, t = App.clock.today();
  const end = e.time ? m2hm(endMin(e)) : "";
  const extra = [o.showDate ? relDay(e.date, t) : "", e.project, e.note, e.source === "chat" ? "Claude 代记" : ""].filter(Boolean).join("  ");
  const bell = filter.bellTag(e, "event", "bell-in");
  const b = h("button",{class:"ev",type:"button",style:"background:"+projColor(e.project),onclick:()=>openSheet("event",e)},
    h("span",{class:"et"}, e.time || "全天", end ? h("small",null,"至 "+end) : null),
    h("span",{class:"eb"}, h("span",{class:"en"}, o.q ? filter.hl(e.title, o.q) : e.title),
      (extra || bell) ? h("span",{class:"ex",style:"display:block"}, o.q ? filter.hl(extra, o.q) : extra, extra && bell ? "  " : null, bell) : null));
  if (S.fresh.has(e.id) || V.flash.has(e.id)) b.classList.add("fresh");
  return b;
}
// 日程页的截止行：圆形勾选框可以直接勾掉（划线、停顿后移出，需求澄清 #38），点标题打开编辑
function deadlineRow(x){
  const row = h("div",{class:"deadline"+(x.done?" done":"")+(S.fresh.has(x.id) || V.flash.has(x.id) ? " fresh":""),"data-id":x.id});
  const ck = h("button",{class:"ck",type:"button","aria-pressed":x.done?"true":"false","aria-label":"完成："+x.title}, h("span",{html:ICON_CHECK}));
  ck.onclick = () => App.ui.todos.toggleInList(x, row);
  row.append(ck, h("button",{class:"dt",type:"button",onclick:()=>openSheet("todo",x)}, h("span",{class:"tt"},x.title)), h("span",{class:"dk"},"截止"));
  return row;
}
function groupByDay(){
  const ev = {}, dl = {};
  for (const e of visEv().filter(filter.inScope)) (ev[e.date] = ev[e.date] || []).push(e);
  for (const x of visTd().filter(x => x.due && !x.done && filter.inScope(x))) (dl[x.due] = dl[x.due] || []).push(x);
  return {ev, dl};
}
// 标题：本周“10月 本周”；别的周“11月 第1周”（按这一周的周四算属于哪个月、第几周）
function weekTitle(t){
  const thu = parse(addDays(V.weekStart, 3));
  if (V.weekStart === mondayOf(t)) return (thu.getMonth()+1) + "月 本周";
  return (thu.getMonth()+1) + "月 第" + Math.ceil(thu.getDate() / 7) + "周";
}
function renderWeek(t, g){
  const title = weekTitle(t), away = V.weekStart !== mondayOf(t);
  $("wk-title").textContent = title;
  $("wk-title").setAttribute("aria-label", title + (away ? "，点按回到今天" : ""));
  // 不在本周时才显示；不显示时只隐藏、保留位置，列表不跳动（UI 复查 #11）
  const bt = $("wk-today");
  bt.classList.toggle("off", !away); bt.disabled = !away; bt.setAttribute("aria-hidden", away ? "false" : "true"); bt.tabIndex = away ? 0 : -1;
  const wk = $("week"); wk.textContent = "";
  for (let i = 0; i < 7; i++){
    const k = addDays(V.weekStart, i), d = parse(k), evs = g.ev[k] || [], dls = g.dl[k] || [];
    const dots = h("span",{class:"dots","aria-hidden":"true"});
    evs.slice(0, C.WEEK_DOTS_MAX).forEach(e => dots.append(h("b",{style:"background:"+projColor(e.project)})));
    if (dls.length) dots.append(h("i",{class:"dl"}));
    const say = [evs.length ? evs.length + " 项日程" : "", dls.length ? dls.length + " 件截止" : ""].filter(Boolean).join("、");
    wk.append(h("button",{type:"button",class:"day"+(k===t?" today":"")+(k===V.selDay?" sel":""),"aria-label":relDay(k, t)+(say?"，"+say:""),"aria-pressed":k===V.selDay?"true":"false",
      onclick:()=>{ V.selDay = k; renderSched(); }},
      h("span",{class:"w"},WK[d.getDay()].slice(1)), h("span",{class:"n"},d.getDate()), dots));
  }
}
function renderDay(t, g){
  const dl = $("day-list"); dl.textContent = "";
  dl.append(h("div",{class:"dhead"+(V.selDay===t?" is-today":"")}, relDay(V.selDay, t)));
  if (!ready()){ dl.append(...skeleton(2)); return; }
  const list = (g.ev[V.selDay] || []).slice().sort(byTime), dls = g.dl[V.selDay] || [];
  if (!list.length && !dls.length) dl.append(emptyBox("这一天还没有安排", h("button",{class:"linkbtn",type:"button",style:"display:block;margin-top:4px",onclick:()=>openSheet("event",null,V.selDay)},"给这天记一件事")));
  list.forEach(e => dl.append(evBlock(e)));
  dls.forEach(x => dl.append(deadlineRow(x)));
}
function renderUpcoming(t){
  const up = $("up-list"); up.textContent = "";
  if (!ready()){ up.append(...skeleton(2)); return; }
  const after = visEv().filter(e => filter.inScope(e) && e.date > (V.selDay > t ? V.selDay : t) && e.date !== V.selDay).sort(byTime).slice(0, C.UPCOMING_MAX);
  $("up-meta").textContent = after.length ? after.length+" 项" : "";
  if (!after.length){ up.append(emptyBox("后面还没有安排", "以后的日程会按日期排在这里。")); return; }
  let cur = null;
  for (const e of after){
    if (e.date !== cur){ cur = e.date; up.append(h("div",{class:"dhead"}, relDay(cur, t))); }
    up.append(evBlock(e));
  }
}
function renderSched(){
  const t = App.clock.today(), g = groupByDay();
  renderWeek(t, g);
  filter.render("sched-filters");
  renderDay(t, g);
  renderUpcoming(t);
}
// 翻周：保持选中的星期几（TC-SCHED-03）
function shiftWeek(n){ V.weekStart = addDays(V.weekStart, 7 * n); V.selDay = addDays(V.selDay, 7 * n); renderSched(); }
function backToToday(){ const t = App.clock.today(); V.weekStart = mondayOf(t); V.selDay = t; renderSched(); $("wk-title").focus(); }
function init(){
  $("wk-prev").onclick = () => shiftWeek(-1);
  $("wk-next").onclick = () => shiftWeek(1);
  $("wk-today").onclick = backToToday;
  $("wk-title").onclick = backToToday;
}

App.ui.schedule = {render: renderSched, evBlock, deadlineRow, init};
