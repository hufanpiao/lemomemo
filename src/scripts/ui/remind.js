// 职责：页面开着时的提醒（v3 T6，界面依据草图第 3 版 ①A ①B、采纳结论 #1 #12、需求澄清 #3 #7 #31）。
//       update() 用 logic/remind.js 算出现在该提醒的条目；新出现的响一声提示音、记运行日志。
//       情况 A：被提醒的正好是“下一件事”且今天页看得见 → 由 ui/today.js 把下一件事卡片画成提醒状态（forItem 查询）；
//       情况 B：其余的在抬头下方显示一张反色提醒卡片，只显示最早的一条，右上角标“+N”。
//       “知道了”写 notifiedFor，“10 分钟后”写 snoozeAt（data/write.js）；别的设备确认后这里自动收起，并提示“已在别处确认”。
// 依赖：core/date.js、logic/remind.js、logic/format.js、data/state.js、ui/dom.js、ui/view-state.js、ui/toast.js
// 运行时调用：data/write.js、platform/notify.js、data/log.js、ui/render.js、App.clock
App.ui = App.ui || {};

const R = App.logic.remind;
const {relDay, dueText, startsText} = App.logic.format;
const {hm2m, minOfDay} = App.core.date;
const {$, h} = App.ui.dom;
const V = App.ui.view, toast = App.ui.toast;
const visEv = App.data.visEv, visTd = App.data.visTd, ready = App.data.ready;

const ICON_BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>';
const keyOf = d => d.kind + ":" + d.item.id + ":" + d.at;

let current = [];              // 现在该提醒的：[{kind, item, at}]
let shown = new Set();         // 本次打开页面后已经出过的（响过铃、做过入场动画）
const handledHere = new Set(); // 在本机点过“知道了 / 10 分钟后”的
let entering = new Set();      // 这一轮新出现的（做入场动画）

// 每次重绘前调用：重新计算，处理新出现的和被别处确认的
function update(){
  if (!ready()){ current = []; return; }
  const now = App.clock.now();
  const next = R.dueList(visEv(), visTd(), now, 0);
  const keys = new Set(next.map(keyOf));
  const fresh = next.filter(d => !shown.has(keyOf(d)));
  entering = new Set(fresh.map(keyOf));
  if (fresh.length){
    App.platform.notify.chime();
    fresh.forEach(d => App.data.log.run("remind_shown", null, {coll: d.kind === "event" ? "events" : "todos", id: d.item.id}));
  }
  for (const k of shown){
    if (!keys.has(k) && !handledHere.has(k)){
      const [kind, id] = k.split(":");
      const item = (kind === "event" ? visEv() : visTd()).find(x => x.id === id);
      if (item && item.notifiedFor) toast.show("已在别处确认");
    }
  }
  current = next;
  fresh.forEach(d => shown.add(keyOf(d)));
  shown = new Set([...shown].filter(k => keys.has(k)));
}
// 情况 A 用：这一条现在是否在提醒中，是就返回 {at}
function forItem(kind, item){
  const d = current.find(x => x.kind === kind && x.item.id === item.id);
  return d ? {at: d.at} : null;
}
// 提醒卡片上的第一行文字
function headline(d){
  const t = App.clock.today(), x = d.item;
  if (d.kind === "event"){
    if (!x.time) return relDay(x.date, t).split(" ")[0] + " 全天";
    const span = R.eventSpan(x), nowMs = App.clock.now();
    const mins = Math.round((span.start - nowMs) / 60000);
    return x.date === t ? startsText(mins, minOfDay(span.end)) : relDay(x.date, t) + " " + x.time;
  }
  return dueText(x.due, t);
}
function actions(d, cls){
  return h("div",{class:"r-acts " + (cls || "")},
    h("button",{type:"button",class:"ok",onclick: ev => { ev.stopPropagation(); ack(d); }},"知道了"),
    h("button",{type:"button",class:"later",onclick: ev => { ev.stopPropagation(); snooze(d); }},"10 分钟后"));
}
function ack(d){ handledHere.add(keyOf(d)); App.data.write.ackReminder(d.kind, d.item, d.at); }
function snooze(d){ handledHere.add(keyOf(d)); App.data.write.snoozeReminder(d.kind, d.item, d.at); toast.show("10 分钟后再提醒"); }
const offline = () => globalThis.navigator && navigator.onLine === false;

// 下一件事卡片进入提醒状态时要插的两部分（由 ui/today.js 调用）
function decorateNext(kind, item){
  const r = forItem(kind, item);
  if (!r) return null;
  const d = {kind, item, at: r.at};
  return {
    bell: h("span",{class:"bell-row"}, h("span",{class:"bell-ico", html:ICON_BELL}), "提醒：" + headline(d), offline() ? h("span",{class:"offline-tag"},"离线，提醒可能延迟") : null),
    acts: actions(d),
    isNew: entering.has(keyOf(d)),
  };
}

// 情况 B：反色卡片。exclude：已经由下一件事卡片显示的那一条（{kind, id}）
function renderCard(exclude){
  const slot = $("remind"); if (!slot) return;
  const list = current.filter(d => !(exclude && d.kind === exclude.kind && d.item.id === exclude.id));
  slot.textContent = "";
  if (!list.length) return;
  const d = list[0], x = d.item;
  const meta = [x.project, d.kind === "event" ? "日程" : "待办"].filter(Boolean).join("  ");
  const card = h("div",{class:"remind-inv", role:"alert"},
    h("span",{class:"bell-row"}, h("span",{class:"bell-ico", html:ICON_BELL}), headline(d),
      offline() ? h("span",{class:"offline-tag"},"离线，提醒可能延迟") : null,
      list.length > 1 ? h("span",{class:"more-n", "aria-label":"还有 " + (list.length - 1) + " 条提醒"},"+" + (list.length - 1)) : null),
    h("span",{class:"rt"}, x.title),
    meta ? h("span",{class:"rm"}, meta) : null,
    actions(d));
  if (entering.has(keyOf(d)) || slot.dataset.key !== keyOf(d)) card.classList.add("enter");
  slot.dataset.key = keyOf(d);
  slot.append(card);
}

// 今天页看得见吗（手机上在今天页，或者电脑上三栏同时显示）
const todayVisible = () => V.view === "today" || (globalThis.matchMedia && matchMedia("(min-width:960px)").matches);

function init(){
  App.clock.on("wake", () => App.ui.render());
}

App.ui.remind = {init, update, forItem, decorateNext, renderCard, todayVisible, ICON_BELL};
