// 职责：今天视图里的时间轴：只显示“现在前后 + 有安排的时段”，重叠的日程分列并排，全天日程放上方胶囊，红线标出现在。
// 依赖：core/const.js、core/date.js、logic/items.js、logic/projects.js、logic/sort.js、data/state.js、ui/dom.js
// 运行时调用：ui/sheet.js
App.ui = App.ui || {};

const C = App.core.C;
const {pad, m2hm} = App.core.date;
const {startMin, endMin} = App.logic.items;
const {projColor} = App.logic.projects;
const {byTime} = App.logic.sort;
const S = App.data.state, visEv = App.data.visEv, ready = App.data.ready;
const {$, h} = App.ui.dom;
const openSheet = (...a) => App.ui.sheet.open(...a);

// 把同时段重叠的日程分到并排的几列：给每项写上 k（第几列）和 n（这一簇共几列）
function layoutLanes(items){
  let cluster = [], cEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const it of cluster){ let k = lanes.findIndex(end => end <= it.s); if (k < 0){ k = lanes.length; lanes.push(0); } lanes[k] = it.en; it.k = k; }
    for (const it of cluster) it.n = lanes.length;
    cluster = []; cEnd = -1;
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
  const items = layoutLanes(timed.map(e => ({e, s:startMin(e), en:endMin(e)})));
  for (const it of items){
    const top = (it.s - sH*60)/60*PX, ht = Math.max(C.TL_BLOCK_MIN_PX, (it.en-it.s)/60*PX - 4);
    const w = 100/it.n;
    const b = h("button",{class:"blk"+(it.en <= nm ? " past":""),type:"button",
      style:"top:"+(top+2)+"px;height:"+ht+"px;left:calc("+(w*it.k)+"% + 6px);width:calc("+w+"% - 8px);background:"+projColor(it.e.project),
      onclick:()=>openSheet("event",it.e)},
      h("span",{class:"bt"},it.e.title), ht > C.TL_META_MIN_PX ? h("span",{class:"bm"},it.e.time+"–"+m2hm(it.en)+(it.e.project?"  "+it.e.project:"")) : null);
    if (S.fresh.has(it.e.id)) b.classList.add("fresh");
    lane.append(b);
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
