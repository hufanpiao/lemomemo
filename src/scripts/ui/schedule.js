// 职责：“日程”视图：一周日期条（上一周 / 下一周）、选中那天的日程、“接下来”按日期分组的日程；
//       evBlock() 生成一个日程色块，今天视图预告明天时也用。
// 依赖：core/const.js、core/date.js、logic/items.js、logic/projects.js、logic/sort.js、logic/format.js、
//       data/state.js、ui/dom.js、ui/view-state.js
// 运行时调用：ui/sheet.js、App.clock
App.ui = App.ui || {};

const C = App.core.C;
const {WK, parse, addDays, m2hm, mondayOf} = App.core.date;
const {endMin} = App.logic.items;
const {projColor} = App.logic.projects;
const {byTime} = App.logic.sort;
const {relDay} = App.logic.format;
const S = App.data.state, visEv = App.data.visEv, ready = App.data.ready;
const {$, h, skeleton, emptyBox} = App.ui.dom;
const V = App.ui.view;
const openSheet = (...a) => App.ui.sheet.open(...a);

function evBlock(e){
  const end = e.time ? m2hm(endMin(e)) : "";
  const b = h("button",{class:"ev",type:"button",style:"background:"+projColor(e.project),onclick:()=>openSheet("event",e)},
    h("span",{class:"et"}, e.time || "全天", end ? h("small",null,"至 "+end) : null),
    h("span",{class:"eb"}, h("span",{class:"en"},e.title),
      (e.project || e.note || e.source === "chat") ? h("span",{class:"ex",style:"display:block"},[e.project, e.note, e.source === "chat" ? "Claude 代记" : ""].filter(Boolean).join("  ")) : null));
  if (S.fresh.has(e.id)) b.classList.add("fresh");
  return b;
}
function groupByDay(){
  const byDay = {};
  for (const e of visEv()) (byDay[e.date] = byDay[e.date] || []).push(e);
  return byDay;
}
function renderWeek(t, byDay){
  const d0 = parse(V.weekStart), d6 = parse(addDays(V.weekStart,6));
  $("wk-title").textContent = (d0.getMonth()+1)+"月" + (V.weekStart === mondayOf(t) ? " 本周" : (d0.getDate()+"日–"+(d6.getMonth()+1)+"月"+d6.getDate()+"日"));
  const wk = $("week"); wk.textContent = "";
  for (let i = 0; i < 7; i++){
    const k = addDays(V.weekStart, i), d = parse(k);
    const dots = h("span",{class:"dots"});
    (byDay[k] || []).slice(0, C.WEEK_DOTS_MAX).forEach(e => dots.append(h("b",{style:"background:"+projColor(e.project)})));
    wk.append(h("button",{type:"button",class:"day"+(k===t?" today":"")+(k===V.selDay?" sel":""),"aria-label":relDay(k, t)+((byDay[k]||[]).length?"，"+byDay[k].length+" 项":""),"aria-pressed":k===V.selDay?"true":"false",
      onclick:()=>{ V.selDay = k; renderSched(); }},
      h("span",{class:"w"},WK[d.getDay()].slice(1)), h("span",{class:"n"},d.getDate()), dots));
  }
}
function renderDay(t, byDay){
  const dl = $("day-list"); dl.textContent = "";
  dl.append(h("div",{class:"dhead"+(V.selDay===t?" is-today":"")}, relDay(V.selDay, t)));
  if (!ready()){ dl.append(...skeleton(2)); return; }
  const list = (byDay[V.selDay] || []).slice().sort(byTime);
  if (!list.length) dl.append(emptyBox("这一天还没有安排", h("button",{class:"linkbtn",type:"button",style:"display:block;margin-top:4px",onclick:()=>openSheet("event",null,V.selDay)},"给这天记一件事")));
  else list.forEach(e => dl.append(evBlock(e)));
}
function renderUpcoming(t){
  const up = $("up-list"); up.textContent = "";
  if (!ready()){ up.append(...skeleton(2)); return; }
  const after = visEv().filter(e => e.date > (V.selDay > t ? V.selDay : t) && e.date !== V.selDay).sort(byTime).slice(0, C.UPCOMING_MAX);
  $("up-meta").textContent = after.length ? after.length+" 项" : "";
  if (!after.length){ up.append(emptyBox("后面还没有安排", "以后的日程会按日期排在这里。")); return; }
  let cur = null;
  for (const e of after){
    if (e.date !== cur){ cur = e.date; up.append(h("div",{class:"dhead"}, relDay(cur, t))); }
    up.append(evBlock(e));
  }
}
function renderSched(){
  const t = App.clock.today(), byDay = groupByDay();
  renderWeek(t, byDay);
  renderDay(t, byDay);
  renderUpcoming(t);
}
function init(){
  $("wk-prev").onclick = () => { V.weekStart = addDays(V.weekStart,-7); V.selDay = V.weekStart; renderSched(); };
  $("wk-next").onclick = () => { V.weekStart = addDays(V.weekStart,7); V.selDay = V.weekStart; renderSched(); };
}

App.ui.schedule = {render: renderSched, evBlock, init};
