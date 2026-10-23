// “今天”视图：下一件事大卡片、没赶上面板、今天的时间轴（重叠分列、现在红线）、今天要做、晚上 6 点后预告明天。
// 依赖：core/date.js、core/dom.js、logic/projects.js、logic/sort.js、logic/format.js、data/state.js、data/write.js；
//       调用时用到 ui/sheet.js、ui/todos.js、ui/schedule.js。
App.ui = App.ui || {};

const {pad, ymd, today, addDays, dayDiff, hm2m, m2hm, nowMin, md} = App.core.date;
const {$, h, ICON_CHECK, skeleton, emptyBox} = App.core.dom;
const {projColor} = App.logic.projects;
const {byTime, sortTodos, pickNext} = App.logic.sort;
const {relDay, dueText} = App.logic.format;
const S = App.data.state, visEv = App.data.visEv, visTd = App.data.visTd, ready = App.data.ready;
const {toggleDone, reschedule, moveAll} = App.data.write;
const openSheet = (...a) => App.ui.sheet.open(...a);
const todoRow = x => App.ui.todos.row(x);
const evBlock = e => App.ui.schedule.evBlock(e);

const nextThing = () => pickNext(visEv(), visTd(), today(), nowMin());

function renderToday(){
  const box = $("next"); box.textContent = "";
  if (!ready()){ box.append(h("div",{class:"next empty"}, ...skeleton(2))); }
  else {
    const n = nextThing(), nm = nowMin();
    if (!n){
      box.append(h("div",{class:"next empty"}, h("span",{class:"lbl"},"下一件事"), h("span",{class:"big"},"空闲"),
        h("span",{class:"cd"},"今天没有别的安排了。点右下角的＋记一件新的事。")));
    } else if (n.kind === "event"){
      const e = n.item, mins = n.start - nm;
      const cd = mins > 0 ? (mins >= 60 ? Math.floor(mins/60)+" 小时 "+(mins%60 ? mins%60+" 分钟" : "")+"后开始" : mins+" 分钟后开始") : "进行中，"+m2hm(n.end)+" 结束";
      box.append(h("button",{class:"next",type:"button",style:"background:"+projColor(e.project)+";border:0;text-align:left;width:100%",onclick:()=>openSheet("event",e)},
        h("span",{class:"lbl"},"下一件事"), h("span",{class:"big"},e.time), h("span",{class:"cd"},cd),
        h("span",{class:"tt"},e.title), e.project || e.note ? h("span",{class:"proj"},[e.project,e.note].filter(Boolean).join("  ")) : null));
    } else {
      const x = n.item;
      const card = h("div",{class:"next",style:"background:"+projColor(x.project)},
        h("span",{class:"lbl"},"下一件事"), h("span",{class:"big",style:"font-size:40px"}, x.due ? dueText(x.due).replace("截止","") : "待办"),
        h("span",{class:"tt"},x.title), x.project ? h("span",{class:"proj"},x.project) : null,
        h("button",{class:"act",type:"button","aria-label":"完成："+x.title,html:ICON_CHECK,onclick:()=>toggleDone(x,true,null)}));
      card.querySelector(".tt").onclick = () => openSheet("todo", x);
      box.append(card);
    }
  }
  // 没赶上
  const lb = $("late"); lb.textContent = "";
  const t = today();
  const late = visTd().filter(x => !x.done && x.due && x.due < t).sort((a,b) => a.due.localeCompare(b.due));
  if (late.length){
    const p = h("section",{class:"panel late-panel","aria-labelledby":"h-late"},
      h("div",{class:"ph"}, h("h2",{id:"h-late"},late.length+" 件没赶上"),
        late.length > 1 ? h("button",{class:"btn-dark",type:"button",onclick:()=>moveAll(late)},"全部改到今天") : null));
    for (const x of late){
      p.append(h("div",{class:"late-row"},
        h("div",{class:"t"}, x.title, h("small",null,"原定 "+md(x.due)+"，晚了 "+(-dayDiff(x.due,t))+" 天")),
        h("div",{class:"mini"},
          h("button",{type:"button",onclick:()=>reschedule(x,t)},"今天"),
          h("button",{type:"button",onclick:()=>reschedule(x,addDays(t,1))},"明天"))));
    }
    lb.append(p);
  }
  renderTimeline();
  // 今天要做
  const ul = $("today-todos"); ul.textContent = "";
  if (!ready()){ ul.append(...skeleton(2)); }
  else {
    const soon = addDays(t,2);
    const list = visTd().filter(x => (!x.done && (!x.due || x.due >= t) && ((x.due && x.due <= soon) || x.important)) ||
      (x.done && x.doneAt && ymd(new Date(x.doneAt)) === t && (x.important || (x.due && x.due <= soon))));
    sortTodos(list);
    if (!list.length){
      const anyOpen = visTd().some(x => !x.done);
      ul.append(h("li",null, emptyBox(anyOpen ? "最近两天没有到期的事" : "没有待办", anyOpen ? "其他待办在“全部待办”里。" : "点右下角的＋，写一句话就能记下。")));
    } else list.forEach(x => ul.append(todoRow(x)));
  }
  // 晚上预告明天
  const tm = $("tomorrow");
  const showTm = new Date().getHours() >= 18;
  tm.hidden = !showTm || !ready();
  if (showTm && ready()){
    const tmr = addDays(t,1);
    const evs = visEv().filter(e => e.date === tmr).sort(byTime);
    $("tm-meta").textContent = relDay(tmr);
    const l = $("tm-list"); l.textContent = "";
    if (!evs.length) l.append(emptyBox("明天还没有安排", "可以早点休息。"));
    else evs.forEach(e => l.append(evBlock(e)));
  }
}

function renderTimeline(){
  const t = today(), tl = $("tl"), ad = $("tl-allday");
  tl.textContent = ""; ad.textContent = "";
  const evs = visEv().filter(e => e.date === t);
  const timed = evs.filter(e => e.time).sort(byTime);
  evs.filter(e => !e.time).forEach(e => ad.append(h("button",{class:"ad",type:"button",style:"background:"+projColor(e.project),onclick:()=>openSheet("event",e)},"全天  "+e.title)));
  $("tl-meta").textContent = timed.length ? timed.length+" 项" : "";
  const nm = nowMin();
  // 只显示“现在前后 + 有安排的时段”，避免大段空白
  let sH = Math.max(0, Math.floor(nm/60) - 1), eH = Math.min(24, Math.floor(nm/60) + 3);
  for (const e of timed){ const s = hm2m(e.time), en = s+(Number(e.durationMin)||60); sH = Math.min(sH, Math.floor(s/60)); eH = Math.max(eH, Math.ceil(en/60)); }
  eH = Math.min(24, eH); if (eH - sH < 4) sH = Math.max(0, eH - 4);
  const PX = 52, H = (eH - sH) * PX;
  const hours = h("div",{class:"hours",style:"height:"+H+"px"}), lane = h("div",{class:"lane",style:"height:"+H+"px"});
  for (let i = sH; i <= eH; i++){
    const y = (i - sH) * PX;
    if (i < eH || i === eH) hours.append(h("span",{style:"top:"+Math.min(H-6,Math.max(6,y))+"px"},pad(i)+":00"));
    lane.append(h("i",{style:"top:"+y+"px"}));
  }
  // 重叠分列
  const items = timed.map(e => ({e, s:hm2m(e.time), en:hm2m(e.time)+(Number(e.durationMin)||60)}));
  let cluster = [], cEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const it of cluster){ let k = lanes.findIndex(end => end <= it.s); if (k < 0){ k = lanes.length; lanes.push(0); } lanes[k] = it.en; it.k = k; }
    for (const it of cluster) it.n = lanes.length;
    cluster = []; cEnd = -1;
  };
  for (const it of items){ if (it.s >= cEnd && cluster.length) flush(); cluster.push(it); cEnd = Math.max(cEnd, it.en); }
  if (cluster.length) flush();
  for (const it of items){
    const top = (it.s - sH*60)/60*PX, ht = Math.max(30, (it.en-it.s)/60*PX - 4);
    const w = 100/it.n;
    const b = h("button",{class:"blk"+(it.en <= nm ? " past":""),type:"button",
      style:"top:"+(top+2)+"px;height:"+ht+"px;left:calc("+(w*it.k)+"% + 6px);width:calc("+w+"% - 8px);background:"+projColor(it.e.project),
      onclick:()=>openSheet("event",it.e)},
      h("span",{class:"bt"},it.e.title), ht > 40 ? h("span",{class:"bm"},it.e.time+"–"+m2hm(it.en)+(it.e.project?"  "+it.e.project:"")) : null);
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

App.ui.today = {render: renderToday, renderTimeline};
