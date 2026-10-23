// “日程”视图：一周日期条（上一周 / 下一周）、选中那天的日程、“接下来”按日期分组的日程；evBlock() 也供今天视图预告明天用。
// 依赖：core/date.js、core/dom.js、logic/projects.js、logic/sort.js、logic/format.js、data/state.js；
//       调用时用到 ui/sheet.js。
App.ui = App.ui || {};

const {WK, parse, today, addDays, hm2m, m2hm, mondayOf} = App.core.date;
const {$, h, skeleton, emptyBox} = App.core.dom;
const {projColor} = App.logic.projects;
const {byTime} = App.logic.sort;
const {relDay} = App.logic.format;
const S = App.data.state, visEv = App.data.visEv, ready = App.data.ready;
const openSheet = (...a) => App.ui.sheet.open(...a);

function evBlock(e){
  const end = e.time ? m2hm(hm2m(e.time)+(Number(e.durationMin)||60)) : "";
  const b = h("button",{class:"ev",type:"button",style:"background:"+projColor(e.project),onclick:()=>openSheet("event",e)},
    h("span",{class:"et"}, e.time || "全天", end ? h("small",null,"至 "+end) : null),
    h("span",{class:"eb"}, h("span",{class:"en"},e.title),
      (e.project || e.note || e.source === "chat") ? h("span",{class:"ex",style:"display:block"},[e.project, e.note, e.source === "chat" ? "Claude 代记" : ""].filter(Boolean).join("  ")) : null));
  if (S.fresh.has(e.id)) b.classList.add("fresh");
  return b;
}
function renderSched(){
  const t = today();
  const d0 = parse(S.weekStart);
  const d6 = parse(addDays(S.weekStart,6));
  $("wk-title").textContent = (d0.getMonth()+1)+"月" + (S.weekStart === mondayOf(t) ? " 本周" : (d0.getDate()+"日–"+(d6.getMonth()+1)+"月"+d6.getDate()+"日"));
  const wk = $("week"); wk.textContent = "";
  const byDay = {};
  for (const e of visEv()) (byDay[e.date] = byDay[e.date] || []).push(e);
  for (let i = 0; i < 7; i++){
    const k = addDays(S.weekStart, i), d = parse(k);
    const dots = h("span",{class:"dots"});
    (byDay[k] || []).slice(0,3).forEach(e => dots.append(h("b",{style:"background:"+projColor(e.project)})));
    wk.append(h("button",{type:"button",class:"day"+(k===t?" today":"")+(k===S.selDay?" sel":""),"aria-label":relDay(k)+((byDay[k]||[]).length?"，"+byDay[k].length+" 项":""),"aria-pressed":k===S.selDay?"true":"false",
      onclick:()=>{ S.selDay = k; renderSched(); }},
      h("span",{class:"w"},WK[d.getDay()].slice(1)), h("span",{class:"n"},d.getDate()), dots));
  }
  const dl = $("day-list"); dl.textContent = "";
  dl.append(h("div",{class:"dhead"+(S.selDay===t?" is-today":"")}, relDay(S.selDay)));
  if (!ready()) dl.append(...skeleton(2));
  else {
    const list = (byDay[S.selDay] || []).slice().sort(byTime);
    if (!list.length) dl.append(emptyBox("这一天还没有安排", h("button",{class:"linkbtn",type:"button",style:"display:block;margin-top:4px",onclick:()=>openSheet("event",null,S.selDay)},"给这天记一件事")));
    else list.forEach(e => dl.append(evBlock(e)));
  }
  const up = $("up-list"); up.textContent = "";
  if (!ready()){ up.append(...skeleton(2)); return; }
  const after = visEv().filter(e => e.date > (S.selDay > t ? S.selDay : t) && e.date !== S.selDay).sort(byTime).slice(0, 30);
  $("up-meta").textContent = after.length ? after.length+" 项" : "";
  if (!after.length){ up.append(emptyBox("后面还没有安排", "以后的日程会按日期排在这里。")); return; }
  let cur = null;
  for (const e of after){
    if (e.date !== cur){ cur = e.date; up.append(h("div",{class:"dhead"}, relDay(cur))); }
    up.append(evBlock(e));
  }
}
function init(){
  $("wk-prev").onclick = () => { S.weekStart = addDays(S.weekStart,-7); S.selDay = S.weekStart; renderSched(); };
  $("wk-next").onclick = () => { S.weekStart = addDays(S.weekStart,7); S.selDay = S.weekStart; renderSched(); };
}

App.ui.schedule = {render: renderSched, evBlock, init};
