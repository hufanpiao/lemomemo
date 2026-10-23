// 职责：新建 / 编辑弹出层的开关与操作（v3 T8，界面依据草图第 3 版 ②③）：
//       新建时只显示一句话输入框、右侧的“加入”和识别结果，细节默认折叠在“改细节”里；编辑时直接展开细节，可以切换类型；
//       保存、类型互转、删除都交给 data/write.js；删除后提示“已删除 1 项”加“撤销”（不显示标题，#17）。
//       弹出层打开时焦点困在里面（Tab 循环），Esc 或点遮罩关闭，焦点回到打开它的按钮。表单状态在 ui/sheet-form.js。
// 依赖：core/const.js、core/date.js、logic/format.js、data/state.js、data/write.js、ui/dom.js、ui/view-state.js、ui/toast.js、ui/sheet-form.js
// 运行时调用：ui/nav.js、App.clock
App.ui = App.ui || {};

const C = App.core.C;
const {mondayOf} = App.core.date;
const {relDay} = App.logic.format;
const write = App.data.write;
const {$} = App.ui.dom;
const V = App.ui.view, toast = App.ui.toast, SF = App.ui.sheetForm, F = App.ui.sheetForm.state;
let lastFocus = null;
const isDesktop = () => globalThis.matchMedia && matchMedia("(min-width:960px)").matches;

function openDetails(){
  $("details").hidden = false; $("details-toggle").hidden = true;
  $("details-toggle").setAttribute("aria-expanded", "true");
  $("acts").hidden = false;
}
function openSheet(kind, item, presetDate){
  if (!App.data.isConnected()){ toast.show("数据未连接，暂时不能编辑"); return; }
  lastFocus = document.activeElement;
  SF.reset(kind, item, presetDate);
  const editingMode = !!item;
  $("sh-title").textContent = editingMode ? (kind === "event" ? "编辑日程" : "编辑待办") : "记一件事";
  $("q-wrap").hidden = editingMode;
  $("details").hidden = !editingMode; $("details-toggle").hidden = editingMode;
  $("details-toggle").setAttribute("aria-expanded", editingMode ? "true" : "false");
  $("acts").hidden = !editingMode;
  $("save").textContent = editingMode ? "保存修改" : "加入";
  $("del").hidden = !editingMode;
  $("del").textContent = kind === "event" ? "删除这条日程" : "删除这条待办";
  $("scrim").hidden = false; $("sheet").hidden = false;
  requestAnimationFrame(() => { $("scrim").classList.add("on"); $("sheet").classList.add("on"); (editingMode ? $("f-title") : $("q")).focus(); });
}
function closeSheet(){
  $("scrim").classList.remove("on"); $("sheet").classList.remove("on");
  setTimeout(() => { $("scrim").hidden = true; $("sheet").hidden = true; }, C.SHEET_ANIM_MS);
  if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
}
const isClosed = () => $("sheet").hidden;

function setBusy(busy){
  for (const id of ["save", "q-add"]){ const b = $(id); b.disabled = busy; }
  $("save").textContent = busy ? "保存中…" : (F.editing ? "保存修改" : "加入");
  $("q-add").textContent = busy ? "…" : "加入";
}
async function onSubmit(ev){
  ev.preventDefault();
  const v = SF.readForm();
  if (!v.title){ openDetails(); $("f-title").focus(); return; }
  if (F.kind === "event" && !v.date){ openDetails(); $("f-date").focus(); return; }
  setBusy(true);
  const editing = F.editing, converting = editing && F.kind !== F.origKind;
  const r = converting ? await write.convert(F.origKind, editing, v) : await write.saveItem(F.kind, editing, v);
  setBusy(false);
  if (!r.ok) return;
  if (r.coll === "events" && !editing){ V.selDay = r.data.date; V.weekStart = mondayOf(r.data.date); }
  closeSheet();
  if (converting) toast.show(r.coll === "events" ? "已改成日程" : "已改成待办");
  else if (editing) toast.show("已保存");
  else if (r.coll === "events") toast.show("已记下日程，" + relDay(r.data.date, App.clock.today()));
  else if (!v.date && V.view === "today" && !isDesktop()) toast.show("已加入待办", "查看", () => App.ui.nav.go("todo"));   // PM-A⑥
  else toast.show("已加入待办");
}
function onDelete(){
  const it = F.editing, coll = write.collOf(F.origKind || F.kind);
  closeSheet();
  if (!it) return;
  write.softDelete(coll, it);
  toast.show("已删除 1 项", "撤销", () => write.restore(coll, it), C.TOAST_UNDO_MS);
}
// 焦点困在弹出层里：Tab / Shift+Tab 循环
function trapFocus(e){
  if (e.key !== "Tab" || $("sheet").hidden) return;
  const els = [...$("sheet").querySelectorAll("button, input, select, textarea, [tabindex]")].filter(el => !el.disabled && el.offsetParent !== null);
  if (!els.length) return;
  const first = els[0], last = els[els.length - 1];
  if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
}
function init(){
  SF.init();
  $("details-toggle").onclick = openDetails;
  $("cancel").onclick = closeSheet; $("scrim").onclick = closeSheet;
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); trapFocus(e); });
  $("del").onclick = onDelete;
  $("sheet").addEventListener("submit", onSubmit);
  $("plus").onclick = () => openSheet(null, null, V.view === "sched" ? V.selDay : null);
}

App.ui.sheet = {open: openSheet, close: closeSheet, isClosed, init, openDetails};
