// 职责：弹出层的表单状态（v3 T8，界面依据草图第 3 版 ②③、采纳结论 #3–#6 #16 #17、需求澄清 #22 #33 #37）：
//       类型切换、快捷日期胶囊、提醒选项胶囊、识别结果胶囊（每项是按钮，点了展开对应字段；手动改过的加锁、不再被覆盖）、
//       一句话识别停顿 250ms 后才填表。读表单交给 ui/sheet.js 保存。
// 依赖：core/const.js、core/date.js、logic/remind.js、logic/format.js、logic/projects.js、logic/parse-quick.js、data/state.js、ui/dom.js、ui/view-state.js
// 运行时调用：ui/sheet.js、App.clock
App.ui = App.ui || {};

const R = App.logic.remind;
const {relDay} = App.logic.format;
const {projColor} = App.logic.projects;
const {addDays, mondayOf, parse, m2hm} = App.core.date;
const C = App.core.C;
const {$, h} = App.ui.dom;
const V = App.ui.view;
const RECOG_DEBOUNCE_MS = 250;
const ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

// kind：当前类型；origKind：编辑时原来的类型（切换类型时用来转换）；remind：undefined＝没动过（按默认规则）
const F = {kind:"todo", origKind:null, editing:null, locks:new Set(), remind:undefined};
let debounce = null;
const today = () => App.clock.today();
const hasTime = () => F.kind === "event" && !!$("f-time").value;

function setKind(k){
  F.kind = k;
  document.querySelectorAll("#seg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.k === k ? "true" : "false"));
  document.querySelectorAll("#sheet .ev-only").forEach(el => el.hidden = k !== "event");
  document.querySelectorAll("#sheet .td-only").forEach(el => el.hidden = k !== "todo");
  $("push-1h").hidden = !(k === "event" && F.editing && F.origKind === "event");
  $("f-date-lab").textContent = k === "event" ? "日期" : "截止日期";
  $("date-chips-lab").textContent = k === "event" ? "日期" : "截止";
  $("f-note-lab").textContent = k === "event" ? "地点或备注" : "备注";
  $("f-date").required = k === "event";
  if (k === "event" && !$("f-date").value) $("f-date").value = V.selDay || today();
  refresh();
}
// 表单当前内容，按条目的样子组装（给提醒规则算默认值、标签用）
function draft(){
  const d = {date:$("f-date").value, time: F.kind === "event" ? $("f-time").value : "", due:$("f-date").value,
    important:$("f-imp").checked, done:false, deletedAt:null, durationMin:Number($("f-dur").value) || C.DEFAULT_DURATION_MIN};
  if (F.remind !== undefined){ if (hasTime()) d.remindMin = F.remind; else d.remindDays = F.remind; }
  else if (F.editing){ d.remindMin = F.editing.remindMin; d.remindDays = F.editing.remindDays; }
  return d;
}

// —— 快捷日期（#22）——
function dateChoices(){
  const t = today(), dow = parse(t).getDay();
  const list = [["今天", t], ["明天", addDays(t, 1)], ["周六", addDays(t, (6 - dow + 7) % 7)], ["下周一", addDays(mondayOf(t), 7)]];
  if (F.kind === "todo") list.push(["不设", ""]);
  return list;
}
function renderDateChips(){
  const box = $("date-chips"); box.textContent = "";
  const cur = $("f-date").value;
  box.append(h("button",{type:"button",class:"opt",onclick:() => { const el = $("f-date"); el.focus(); try { el.showPicker && el.showPicker(); } catch(e){} }},"选日期…"));
  for (const [label, val] of dateChoices()){
    box.append(h("button",{type:"button",class:"opt","aria-pressed": cur === val ? "true" : "false",
      onclick:() => { $("f-date").value = val; F.locks.add("date"); refresh(); }}, label));
  }
}

// —— 提醒选项 ——
function renderRemind(){
  const box = $("remind-chips"); box.textContent = "";
  const opts = R.options(F.kind, hasTime());
  if (F.remind !== undefined && !opts.some(o => o.value === F.remind)) F.remind = undefined;   // 换了类型，原选项不适用
  const noDate = !$("f-date").value;
  const hideRow = noDate && F.kind === "todo";
  box.hidden = hideRow; $("remind-lab").hidden = hideRow;
  const cur = noDate && F.kind === "todo" ? null : (F.remind !== undefined ? F.remind : R.currentValue(draft(), F.kind));
  for (const o of opts){
    box.append(h("button",{type:"button",class:"opt",role:"radio","aria-checked": o.value === cur ? "true" : "false", disabled: noDate && F.kind === "todo" ? true : null,
      onclick:() => { F.remind = o.value; F.locks.add("remind"); refresh(); }}, o.label));
  }
}

// —— 识别结果胶囊：每项是按钮，点了展开对应字段；锁住的加锁形图标 ——
function chip(field, text, focusId){
  const locked = F.locks.has(field);
  return h("button",{type:"button",class:"v" + (locked ? " lock" : ""),
    "aria-label": text + (locked ? "，已手动修改，不会被识别结果覆盖" : "，点按修改"),
    onclick:() => { App.ui.sheet.openDetails(); const el = $(focusId); if (el) el.focus(); }},
    locked ? h("span",{class:"lock-ico", html:ICON_LOCK}) : null, text);
}
function renderRecog(){
  const box = $("recog");
  const show = !F.editing && !!$("q").value.trim();
  box.hidden = !show; box.textContent = "";
  if (!show) return;
  const d = draft(), t = today();
  box.append(chip("kind", F.kind === "event" ? "日程" : "待办", "seg"));
  if ($("f-date").value) box.append(chip("date", (F.kind === "todo" ? "截止 " : "") + relDay($("f-date").value, t), "f-date"));
  if (F.kind === "event") box.append(chip("time", $("f-time").value || "全天", "f-time"));
  if ($("f-proj").value.trim()) box.append(chip("project", $("f-proj").value.trim(), "f-proj"));
  if (F.kind === "todo" && $("f-imp").checked) box.append(chip("important", "重要", "f-imp"));
  const lab = R.label(d, F.kind);
  if (lab || F.remind === null) box.append(chip("remind", lab ? "提醒：" + lab : "不提醒", "remind-chips"));
}
function fillProjChips(){
  const c = $("proj-chips"); c.textContent = "";
  const dl = $("proj-list"); dl.textContent = "";
  App.data.projects().forEach(p => {
    dl.append(h("option",{value:p}));
    c.append(h("button",{class:"f",type:"button","aria-pressed":$("f-proj").value===p?"true":"false",
      onclick:()=>{ $("f-proj").value = $("f-proj").value === p ? "" : p; F.locks.add("project"); refresh(); }},
      h("span",{class:"sw",style:"background:"+projColor(p)}), p));
  });
}
function refresh(){ renderDateChips(); renderRemind(); renderRecog(); fillProjChips(); }

// —— 一句话识别：停顿 250ms 后填表，锁住的字段不动 ——
function applyParse(){
  const s = $("q").value;
  if (!s.trim()){ refresh(); return; }
  const p = App.logic.parseQuick(s, today(), App.data.projects());
  const L = F.locks;
  if (!L.has("kind") && p.kind !== F.kind){ F.kind = p.kind; setKind(p.kind); }
  if (!L.has("title")) $("f-title").value = p.title;
  if (!L.has("date")) $("f-date").value = p.date || (F.kind === "event" ? today() : "");
  if (!L.has("time")) $("f-time").value = p.time;
  if (!L.has("important")) $("f-imp").checked = p.important;
  if (!L.has("project")) $("f-proj").value = p.project;
  if (!L.has("remind")) F.remind = !p.remind ? undefined : p.remind.off ? null : p.remind.min != null ? p.remind.min : p.remind.days;
  refresh();
}
function onQuickInput(){ clearTimeout(debounce); debounce = setTimeout(applyParse, RECOG_DEBOUNCE_MS); }
function flushParse(){ if (debounce){ clearTimeout(debounce); debounce = null; applyParse(); } }

// 打开弹出层时重置。kind 为 null 表示新建时让识别结果决定
function reset(kind, item, presetDate){
  F.editing = item || null; F.origKind = item ? kind : null; F.locks = new Set(); F.remind = undefined;
  clearTimeout(debounce); debounce = null;
  $("q").value = "";
  $("f-title").value = item ? item.title : "";
  $("f-date").value = item ? (kind === "event" ? item.date : (item.due || "")) : (presetDate || "");
  $("f-time").value = item && item.time || "";
  const dur = String(item && item.durationMin || C.DEFAULT_DURATION_MIN), sel = $("f-dur");
  if (![...sel.options].some(o => o.value === dur)) sel.append(h("option",{value:dur}, dur + " 分钟"));   // 不在选项里的时长也保留（PM-C②）
  sel.value = dur;
  $("f-note").value = item && item.note || "";
  $("f-imp").checked = !!(item && item.important);
  $("f-proj").value = item && item.project || "";
  $("raw").hidden = !(item && item.rawText);
  $("raw").textContent = item && item.rawText ? "原话：" + item.rawText : "";
  // 电脑上不提麦克风（#37）
  const coarse = globalThis.matchMedia && matchMedia("(pointer:coarse)").matches;
  $("q").placeholder = coarse ? "说或写一句话，例如：明天下午3点和 NEOX 对片（点键盘上的麦克风，中文、韩文都能说）" : "写一句话，例如：明天下午3点和 NEOX 对片";
  setKind(kind || (presetDate ? "event" : "todo"));
}
function readForm(){
  flushParse();
  return {title:$("f-title").value.trim(), date:$("f-date").value, time: F.kind === "event" ? $("f-time").value : "", dur:$("f-dur").value,
    project:$("f-proj").value.trim(), note:$("f-note").value.trim(), important:$("f-imp").checked, remind:F.remind, raw:$("q").value.trim()};
}
// 日程“推后 1 小时”：跨过零点时日期加一天（#22）
function pushHour(){
  const t = $("f-time").value; if (!t) return;
  const [hh, mm] = t.split(":").map(Number); let m = hh * 60 + mm + 60, d = $("f-date").value;
  if (m >= 24 * 60){ m -= 24 * 60; d = addDays(d, 1); }
  $("f-time").value = m2hm(m);
  $("f-date").value = d; refresh();
}
function init(){
  document.querySelectorAll("#seg button").forEach(b => b.onclick = () => { F.locks.add("kind"); setKind(b.dataset.k); });
  $("q").oninput = onQuickInput;
  const lockOn = (id, field, ev) => $(id).addEventListener(ev, () => { F.locks.add(field); refresh(); });
  lockOn("f-title", "title", "input"); lockOn("f-date", "date", "change"); lockOn("f-time", "time", "change");
  lockOn("f-imp", "important", "change"); lockOn("f-proj", "project", "input");
  $("push-1h").onclick = pushHour;
}

App.ui.sheetForm = {state: F, init, reset, readForm, refresh, setKind};
