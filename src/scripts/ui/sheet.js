// 新建 / 编辑弹出层：一句话输入实时解析填表、日程 / 待办切换、项目胶囊、保存、取消、删除（可撤销）。
// 依赖：core/date.js、core/dom.js、logic/projects.js、logic/parse-quick.js、logic/format.js、
//       data/store.js、data/state.js、data/fields.js、data/write.js、ui/toast.js。
App.ui = App.ui || {};

const {today, mondayOf} = App.core.date;
const {$, h} = App.core.dom;
const {projColor} = App.logic.projects;
const {relDay} = App.logic.format;
const store = App.data.store, S = App.data.state, fields = App.data.fields;
const {write, scheduleDelete} = App.data.write;
const toast = (...a) => App.ui.toast.show(...a);
const parseQuick = s => App.logic.parseQuick(s, today(), App.data.projects());

let sheetKind = "todo", editing = null, lastFocus = null;
function setKind(k){
  sheetKind = k;
  document.querySelectorAll("#seg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.k === k ? "true" : "false"));
  document.querySelectorAll(".ev-only").forEach(el => el.hidden = k !== "event");
  document.querySelectorAll(".td-only").forEach(el => el.hidden = k !== "todo");
  $("f-date-lab").textContent = k === "event" ? "日期" : "截止日期";
  $("f-date").required = k === "event";
}
function fillProjChips(){
  const c = $("proj-chips"); c.textContent = "";
  const dl = $("proj-list"); dl.textContent = "";
  App.data.projects().forEach(p => {
    dl.append(h("option",{value:p}));
    c.append(h("button",{class:"f",type:"button","aria-pressed":$("f-proj").value===p?"true":"false",onclick:()=>{ $("f-proj").value = $("f-proj").value === p ? "" : p; fillProjChips(); }},
      h("span",{class:"sw",style:"background:"+projColor(p)}), p));
  });
}
function openSheet(kind, item, presetDate){
  if (!store.connected){ toast("数据未连接，暂时不能编辑"); return; }
  lastFocus = document.activeElement;
  editing = item || null;
  $("sh-title").textContent = item ? (kind === "event" ? "编辑日程" : "编辑待办") : "新建";
  $("q-wrap").hidden = !!item; $("seg").hidden = !!item;
  $("q").value = "";
  $("f-title").value = item ? item.title : "";
  $("f-date").value = item ? (kind === "event" ? item.date : (item.due || "")) : (presetDate || "");
  $("f-time").value = item && item.time || "";
  $("f-dur").value = String(item && item.durationMin || 60);
  if (![...$("f-dur").options].some(o => o.value === $("f-dur").value)) $("f-dur").value = "60";
  $("f-note").value = item && item.note || "";
  $("f-imp").checked = !!(item && item.important);
  $("f-proj").value = item && item.project || "";
  $("raw").hidden = !(item && item.rawText);
  $("raw").textContent = item && item.rawText ? "原话：" + item.rawText : "";
  $("del").hidden = !item;
  $("save").textContent = item ? "保存修改" : "加入";
  setKind(kind || (presetDate ? "event" : "todo"));
  fillProjChips();
  $("scrim").hidden = false; $("sheet").hidden = false;
  requestAnimationFrame(() => { $("scrim").classList.add("on"); $("sheet").classList.add("on"); (item ? $("f-title") : $("q")).focus(); });
}
function closeSheet(){
  $("scrim").classList.remove("on"); $("sheet").classList.remove("on");
  setTimeout(() => { $("scrim").hidden = true; $("sheet").hidden = true; }, 340);
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
async function onSubmit(ev){
  ev.preventDefault();
  const title = $("f-title").value.trim(); if (!title){ $("f-title").focus(); return; }
  const now = Date.now(), proj = $("f-proj").value.trim(), raw = $("q").value.trim();
  let coll, data;
  if (sheetKind === "event"){
    const date = $("f-date").value; if (!date){ $("f-date").focus(); return; }
    coll = "events";
    data = fields.eventFields({title, date, time:$("f-time").value, dur:$("f-dur").value, project:proj, note:$("f-note").value.trim()}, now);
  } else {
    coll = "todos";
    data = fields.todoFields({title, date:$("f-date").value, important:$("f-imp").checked, project:proj}, now);
  }
  $("save").disabled = true; $("save").textContent = "保存中…";
  let ok;
  if (editing){
    const id = editing.id;
    ok = await write(() => store.update(coll, id, data));
  } else {
    fields.asNew(data, coll, now, raw);
    const id = store.newId(coll);
    S.localIds.add(id);
    ok = await write(() => store.add(coll, id, data));
    if (ok && coll === "events"){ S.selDay = data.date; S.weekStart = mondayOf(data.date); }
  }
  $("save").disabled = false; $("save").textContent = editing ? "保存修改" : "加入";
  if (ok){ closeSheet(); toast(editing ? "已保存" : (coll === "events" ? "已记下日程，"+relDay(data.date) : "已加入待办")); }
}
function init(){
  document.querySelectorAll("#seg button").forEach(b => b.onclick = () => { setKind(b.dataset.k); if (b.dataset.k === "event" && !$("f-date").value) $("f-date").value = S.selDay || today(); });
  $("f-proj").oninput = fillProjChips;
  $("q").oninput = () => {
    const p = parseQuick($("q").value);
    if (!$("q").value.trim()) return;
    setKind(p.kind);
    $("f-title").value = p.title; $("f-date").value = p.date; $("f-time").value = p.time;
    $("f-imp").checked = p.important; $("f-proj").value = p.project; fillProjChips();
  };
  $("q").onkeydown = e => { if (e.key === "Enter"){ e.preventDefault(); $("sheet").requestSubmit(); } };
  $("cancel").onclick = closeSheet; $("scrim").onclick = closeSheet;
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });
  $("del").onclick = () => { const it = editing, k = sheetKind; closeSheet(); if (it) scheduleDelete(k === "event" ? "events" : "todos", it); };
  $("sheet").addEventListener("submit", onSubmit);
  $("plus").onclick = () => openSheet(null, null, S.view === "sched" ? S.selDay : null);
}

App.ui.sheet = {open: openSheet, close: closeSheet, init};
