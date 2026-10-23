// 职责：今天视图里的时间轴：只显示“现在前后 + 有安排的时段”，重叠的日程分列并排，全天日程放上方胶囊，红线标出现在。
//       跨夜的日程裁到 24:00，标“到次日”，时间写成“23:00–次日 01:00”（D07）；同一时段最多并排 3 列，
//       其余折叠成一个“+N”块，点了打开日程页的这一天（D08）。
// 依赖：core/const.js、core/date.js、logic/items.js、logic/projects.js、logic/sort.js、data/state.js、ui/dom.js、ui/view-state.js
// 运行时调用：ui/sheet.js、ui/nav.js、ui/render.js
App.ui = App.ui || {};

const C = App.core.C;
const {pad, m2hm, mondayOf} = App.core.date;
const {startMin, endMin} = App.logic.items;
const {projColor} = App.logic.projects;
const {byTime} = App.logic.sort;
const S = App.data.state, visEv = App.data.visEv, ready = App.data.ready;
const {$, h} = App.ui.dom;
const V = App.ui.view;
const DAY_END = 24 * 60;
const openSheet = (...a) => App.ui.sheet.open(...a);

// 把同时段重叠的日程分到并排的几列：给每项写上 k（第几列）、n（这一簇共几列）、c（第几簇）
function layoutLanes(items){
  let cluster = [], cEnd = -1, ci = 0;
  const flush = () => {
    const lanes = [];
    for (const it of cluster){ let k = lanes.findIndex(end => end <= it.s); if (k < 0){ k = lanes.length; lanes.push(0); } lanes[k] = it.en; it.k = k; }
    for (const it of cluster){ it.n = lanes.length; it.c = ci; }
    cluster = []; cEnd = -1; ci++;
  };
  for (const it of items){ if (it.s >= cEnd && cluster.length) flush(); cluster.push(it); cEnd = Math.max(cEnd, it.en); }
  if (cluster.length) flush();
  return items;
}
function renderTimeline(t, nm){
  const tl = $("tl"), ad = $("tl-allday");
  tl.textContent = ""; ad.textContent = "";
  const evs = visEv().filter(e => e.date === t);
  const timed = evs.filter(e => e.time).sort(byTime);
  evs.filter(e => !e.time).forEach(e => ad.append(h("button",{class:"ad",type:"button",style:"background:"+projColor(e.project),onclick:()=>openSheet("event",e)},"全天  "+e.title)));
  $("tl-meta").textContent = timed.length ? timed.length+" 项" : "";
  // 只显示“现在前后 + 有安排的时段”，避免大段空白
  let sH = Math.max(0, Math.floor(nm/60) - C.TL_HOURS_BEFORE), eH = Math.min(24, Math.floor(nm/60) + C.TL_HOURS_AFTER);
  for (const e of timed){ sH = Math.min(sH, Math.floor(startMin(e)/60)); eH = Math.max(eH, Math.ceil(endMin(e)/60)); }
  eH = Math.min(24, eH); if (eH - sH < C.TL_MIN_HOURS) sH = Math.max(0, eH - C.TL_MIN_HOURS);
  const PX = C.TL_PX_PER_HOUR, H = (eH - sH) * PX;
  const hours = h("div",{class:"hours",style:"height:"+H+"px"}), lane = h("div",{class:"lane",style:"height:"+H+"px"});
  for (let i = sH; i <= eH; i++){
    const y = (i - sH) * PX;
    hours.append(h("span",{style:"top:"+Math.min(H-6,Math.max(6,y))+"px"},pad(i)+":00"));
    lane.append(h("i",{style:"top:"+y+"px"}));
  }
  // ce：裁到 24:00 的结束时刻，用来排版和定高度；en 保留真实结束时刻，用来写文字
  const items = layoutLanes(timed.map(e => ({e, s:startMin(e), en:endMin(e), ce:Math.min(endMin(e), DAY_END)})).map(it => Object.assign(it, {en0:it.en, en:it.ce})));
  const place = (s, ce, k, n) => {
    const top = (s - sH*60)/60*PX, ht = Math.min(Math.max(C.TL_BLOCK_MIN_PX, (ce-s)/60*PX - 4), H - top - 2), w = 100/n;
    return {ht, style:"top:"+(top+2)+"px;height:"+ht+"px;left:calc("+(w*k)+"% + 6px);width:calc("+w+"% - 8px);"};
  };
  const MAX = C.TL_MAX_LANES, more = {};
  for (const it of items){
    if (it.n > MAX && it.k >= MAX - 1){ (more[it.c] = more[it.c] || []).push(it); continue; }
    const n = Math.min(it.n, MAX), {ht, style} = place(it.s, it.ce, it.k, n);
    const overnight = it.en0 > DAY_END;
    const when = it.e.time + "–" + (overnight ? "次日 " : "") + m2hm(it.en0);
    const b = h("button",{class:"blk"+(it.ce <= nm ? " past":"")+(overnight ? " overnight" : ""),type:"button",
      style:style+"background:"+projColor(it.e.project),"aria-label":it.e.title+"，"+when+(overnight?"，到次日":""),
      onclick:()=>openSheet("event",it.e)},
      h("span",{class:"bt"},it.e.title), ht > C.TL_META_MIN_PX ? h("span",{class:"bm"},when+(it.e.project?"  "+it.e.project:"")) : null,
      overnight ? h("span",{class:"nd","aria-hidden":"true"},"到次日") : null);
    if (S.fresh.has(it.e.id)) b.classList.add("fresh");
    lane.append(b);
  }
  // 折叠的“+N”：占第 3 列，从这些日程最早的开始画到最晚的结束；点了打开日程页的今天
  for (const list of Object.values(more)){
    const s0 = Math.min(...list.map(x => x.s)), e0 = Math.max(...list.map(x => x.ce));
    const {style} = place(s0, e0, MAX - 1, MAX);
    lane.append(h("button",{class:"blk more",type:"button",style,"aria-label":"同一时段还有 "+list.length+" 项，打开日程页查看",
      onclick:()=>{ V.selDay = t; V.weekStart = mondayOf(t); App.ui.nav.go("sched"); App.ui.render(); }},
      h("span",{class:"bt"},"+"+list.length), h("span",{class:"bm"},"查看全部")));
  }
  if (nm >= sH*60 && nm <= eH*60){
    lane.append(h("div",{class:"now",style:"top:"+((nm - sH*60)/60*PX)+"px"}, h("span",null,m2hm(nm))));
  }
  tl.append(hours, lane);
  if (!timed.length && !evs.length && ready()){
    lane.append(h("div",{style:"position:absolute;left:12px;right:8px;top:8px;color:var(--muted);font-size:14px"},"今天没有定了时间的安排。"));
  }
}

App.ui.todayTimeline = {render: renderTimeline, layoutLanes};
