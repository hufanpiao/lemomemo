// 职责：新建 / 编辑弹出层：一句话输入实时解析填表、日程 / 待办切换、项目胶囊；保存、删除都交给 data/write.js，
//       本文件只负责读表单、开关弹出层和提示（删除后“已删除 + 撤销”，撤销即恢复）。
// 依赖：core/const.js、core/date.js、logic/projects.js、logic/parse-quick.js、logic/format.js、
//       data/state.js、data/write.js、ui/dom.js、ui/view-state.js、ui/toast.js
// 运行时调用：App.clock
App.ui = App.ui || {};

const C = App.core.C;
const {mondayOf} = App.core.date;
const {projColor} = App.logic.projects;
const {relDay} = App.logic.format;
const write = App.data.write;
const {$, h} = App.ui.dom;
const V = App.ui.view, toast = App.ui.toast;
const parseQuick = s => App.logic.parseQuick(s, App.clock.today(), App.data.projects());

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
  if (!App.data.isConnected()){ toast.show("数据未连接，暂时不能编辑"); return; }
  lastFocus = document.activeElement;
  editing = item || null;
  $("sh-title").textContent = item ? (kind === "event" ? "编辑日程" : "编辑待办") : "新建";
  $("q-wrap").hidden = !!item; $("seg").hidden = !!item;
  $("q").value = "";
  $("f-title").value = item ? item.title : "";
  $("f-date").value = item ? (kind === "event" ? item.date : (item.due || "")) : (presetDate || "");
  $("f-time").value = item && item.time || "";
  $("f-dur").value = String(item && item.durationMin || C.DEFAULT_DURATION_MIN);
  if (![...$("f-dur").options].some(o => o.value === $("f-dur").value)) $("f-dur").value = String(C.DEFAULT_DURATION_MIN);
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
  setTimeout(() => { $("scrim").hidden = true; $("sheet").hidden = true; }, C.SHEET_ANIM_MS);
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
const isClosed = () => $("sheet").hidden;

function readForm(){
  return {title:$("f-title").value.trim(), date:$("f-date").value, time:$("f-time").value, dur:$("f-dur").value,
    project:$("f-proj").value.trim(), note:$("f-note").value.trim(), important:$("f-imp").checked, raw:$("q").value.trim()};
}
async function onSubmit(ev){
  ev.preventDefault();
  const v = readForm();
  if (!v.title){ $("f-title").focus(); return; }
  if (sheetKind === "event" && !v.date){ $("f-date").focus(); return; }
  $("save").disabled = true; $("save").textContent = "保存中…";
  const r = await write.saveItem(sheetKind, editing, v);
  if (r.ok && !editing && r.coll === "events"){ V.selDay = r.data.date; V.weekStart = mondayOf(r.data.date); }
  $("save").disabled = false; $("save").textContent = editing ? "保存修改" : "加入";
  if (r.ok){ closeSheet(); toast.show(editing ? "已保存" : (r.coll === "events" ? "已记下日程，"+relDay(r.data.date, App.clock.today()) : "已加入待办")); }
}
function onDelete(){
  const it = editing, coll = write.collOf(sheetKind);
  closeSheet();
  if (!it) return;
  write.softDelete(coll, it);
  const title = it.title.length > C.DELETE_TITLE_CHARS ? it.title.slice(0, C.DELETE_TITLE_CHARS)+"…" : it.title;
  toast.show("已删除“"+title+"”", "撤销", () => write.restore(coll, it), C.TOAST_UNDO_MS);
}
function init(){
  document.querySelectorAll("#seg button").forEach(b => b.onclick = () => { setKind(b.dataset.k); if (b.dataset.k === "event" && !$("f-date").value) $("f-date").value = V.selDay || App.clock.today(); });
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
  $("del").onclick = onDelete;
  $("sheet").addEventListener("submit", onSubmit);
  $("plus").onclick = () => openSheet(null, null, V.view === "sched" ? V.selDay : null);
}

App.ui.sheet = {open: openSheet, close: closeSheet, isClosed, init};
