// 职责：页面开着时的提醒（v3 T6，界面依据草图第 3 版 ①A ①B、采纳结论 #1 #12、需求澄清 #3 #7 #31）。
//       update() 用 logic/remind.js 算出现在该提醒的条目；新出现的响一声提示音、记运行日志。
//       情况 A：被提醒的正好是“下一件事”且今天页看得见 → 由 ui/today.js 把下一件事卡片画成提醒状态（forItem 查询）；
//       情况 B：其余的在抬头下方显示一张反色提醒卡片，只显示最早的一条，右上角标“+N”。
//       “知道了”写 notifiedFor，“10 分钟后”写 snoozeAt（data/write.js）；别的设备确认后这里自动收起，并提示“已在别处确认”。
// 依赖：core/date.js、logic/remind.js、logic/format.js、data/state.js、ui/dom.js、ui/view-state.js、ui/toast.js
// 运行时调用：data/write.js、platform/notify.js、data/log.js、ui/render.js、ui/sheet.js、App.clock
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
let entering = new Set();      // 这一轮新出现的（做入场动画、读屏播报一次）
let elsewhere = null;          // 刚被别的设备确认的那一条：{key, until}，在卡片里停 0.8 秒（UI-4）
const LEAVE_MS = 200, ELSEWHERE_MS = 800;

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
  // 别的设备点了“知道了”：notifiedFor 正好等于这条提醒的时刻才算（代码复审应修 1；本机勾完成、改期不算）
  for (const k of shown){
    if (keys.has(k) || handledHere.has(k)) continue;
    const [kind, id, at] = k.split(":");
    const item = (kind === "event" ? visEv() : visTd()).find(x => x.id === id);
    if (item && String(item.notifiedFor) === at){
      const slot = $("remind");
      if (slot && slot.dataset.key === k) elsewhere = {key:k, until: now + ELSEWHERE_MS};
      else toast.show("已在别处确认");
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
function actions(d){
  return h("div",{class:"r-acts"},
    h("button",{type:"button",class:"ok",onclick: ev => { ev.stopPropagation(); leave(ev.target, () => ack(d)); }},"知道了"),
    h("button",{type:"button",class:"later",onclick: ev => { ev.stopPropagation(); leave(ev.target, () => snooze(d)); }},"10 分钟后"));
}
// 点按钮后先收起 200ms 再写入（写入会触发重绘，卡片就没了）；减少动效时直接写
function leave(btn, then){
  const card = btn.closest(".remind-inv, .next.reminding");
  const reduce = globalThis.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!card || reduce){ then(); return; }
  card.classList.add("leaving");
  setTimeout(then, LEAVE_MS);
}
function ack(d){ handledHere.add(keyOf(d)); App.data.write.ackReminder(d.kind, d.item, d.at); }
function snooze(d){ handledHere.add(keyOf(d)); App.data.write.snoozeReminder(d.kind, d.item, d.at); toast.show("10 分钟后再提醒"); }
const offline = () => globalThis.navigator && navigator.onLine === false;
const bellRow = (text, extra) => h("span",{class:"bell-row"}, h("span",{class:"bell-ico", html:ICON_BELL}), text,
  offline() ? h("span",{class:"offline-tag"},"离线，提醒可能延迟") : null, extra || null);

// 下一件事卡片进入提醒状态时要插的部分（由 ui/today.js 调用）。
// 铃铛行和按钮包在 .rem-extra 里，新出现时高度从 0 展开 240ms（UI-4）；只有新出现时才设 role=alert，避免每分钟重绘时读屏反复朗读
function decorateNext(kind, item){
  const r = forItem(kind, item);
  if (!r) return null;
  const d = {kind, item, at: r.at};
  const isNew = entering.has(keyOf(d));
  return {
    bell: bellRow("提醒：" + headline(d)),
    acts: actions(d),
    isNew,
    announce: isNew ? "提醒：" + item.title + "，" + headline(d) : "",
  };
}

// 情况 B：反色卡片。exclude：已经由下一件事卡片显示的那一条（{kind, id}）
function renderCard(exclude){
  const slot = $("remind"); if (!slot) return;
  const now = App.clock.now();
  if (elsewhere && now < elsewhere.until){
    slot.textContent = "";
    slot.append(h("div",{class:"remind-inv confirmed"}, bellRow("已在别处确认")));
    setTimeout(() => App.ui.render(), elsewhere.until - now + 20);
    return;
  }
  elsewhere = null;
  const list = current.filter(d => !(exclude && d.kind === exclude.kind && d.item.id === exclude.id));
  const prevKey = slot.dataset.key || "";
  if (!list.length){ slot.textContent = ""; slot.dataset.key = ""; return; }
  const d = list[0], x = d.item, key = keyOf(d);
  const meta = [x.project, d.kind === "event" ? "日程" : "待办"].filter(Boolean).join("  ");
  const more = list.length > 1 ? h("span",{class:"more-n", "aria-label":"还有 " + (list.length - 1) + " 条提醒"},"+" + (list.length - 1)) : null;
  const isNew = entering.has(key);
  const card = h("div",{class:"remind-inv", role: isNew ? "alert" : null},
    bellRow(headline(d), more), h("span",{class:"rt"}, x.title), meta ? h("span",{class:"rm"}, meta) : null, actions(d));
  // 同一条：不播动画、不重新播报；换成下一条（+N 切换）：原位淡入 160ms；全新出现：下移淡入 240ms
  if (prevKey && prevKey !== key) card.classList.add("swap");
  else if (isNew) card.classList.add("enter");
  slot.textContent = "";
  slot.dataset.key = key;
  slot.append(card);
}

// 今天页看得见吗（手机上在今天页，或者电脑上三栏同时显示）
const todayVisible = () => V.view === "today" || (globalThis.matchMedia && matchMedia("(min-width:960px)").matches);

function init(){
  App.clock.on("wake", () => App.ui.render());
  // 弹出层开着时 app.js 不重绘，提醒照样要检查（代码复审应修 2）：这时只更新抬头下方的提醒卡片
  App.clock.on("tick", () => { if (!App.ui.sheet.isClosed()){ update(); renderCard(null); } });
}

App.ui.remind = {init, update, forItem, decorateNext, renderCard, todayVisible, ICON_BELL};
