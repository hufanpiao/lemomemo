// 职责：新建 / 编辑弹出层的开关与操作（v3 T8，界面依据草图第 3 版 ②③）：
//       新建时只显示一句话输入框、右侧的“加入”和识别结果，细节默认折叠在“改细节”里；编辑时直接展开细节，可以切换类型；
//       保存、类型互转、删除都交给 data/write.js；删除后提示“已删除 1 项”加“撤销”（不显示标题，#17）。
//       弹出层打开时焦点困在里面（Tab 循环），Esc 或点遮罩关闭，焦点回到打开它的按钮。表单状态在 ui/sheet-form.js。
// 依赖：core/const.js、core/date.js、logic/format.js、data/state.js、data/write.js、ui/dom.js、ui/view-state.js、ui/toast.js、ui/sheet-form.js
// 运行时调用：ui/nav.js、ui/render.js、App.clock
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
  $("save").hidden = !F.editing;   // 新建时输入框右侧已有“加入”，下面不再放第二个（UI-2④）
}
// 键盘弹起时（iPhone 上可视区域变矮），把弹出层抬到键盘上方，识别结果和“加入”都看得到（UI-2①，需实机确认）
function fitKeyboard(){
  const vv = globalThis.visualViewport, sh = $("sheet");
  if (!vv || !sh || sh.hidden) return;
  const covered = Math.max(0, innerHeight - vv.height - vv.offsetTop);
  sh.style.bottom = covered ? covered + "px" : "";
  sh.style.maxHeight = covered ? (vv.height - 12) + "px" : "";
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
  $("save").hidden = false;
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
  if (!v.title){
    // D12：新建时标题藏在折叠的细节里，浏览器的必填提示看不到，所以自己提示
    if (!F.editing){ toast.show("先写一句话再加入"); $("q").focus(); }
    else $("f-title").focus();
    return;
  }
  if (F.kind === "event" && !v.date){ openDetails(); $("f-date").focus(); return; }
  setBusy(true);
  const editing = F.editing, converting = editing && F.kind !== F.origKind;
  const r = converting ? await write.convert(F.origKind, editing, v) : await write.saveItem(F.kind, editing, v);
  setBusy(false);
  if (!r.ok) return;
  if (r.coll === "events" && !editing){ V.selDay = r.data.date; V.weekStart = mondayOf(r.data.date); }
  closeSheet();
  if (converting) toast.show(r.coll === "events" ? "已改成日程" : "已改成待办");
  else if (editing) toast.show("已保存", null, null, C.TOAST_MS, {group:"saved"});
  else if (r.coll === "events") toast.show("已记下日程，" + relDay(r.data.date, App.clock.today()), null, null, C.TOAST_MS, {group:"saved"});
  else if (V.projFilter && v.project !== V.projFilter)   // D16：当前筛选下看不到新条目，说明并给出清除筛选
    toast.show("已加入待办（当前只显示“" + V.projFilter + "”）", "显示全部", () => { V.projFilter = null; App.ui.render(); });
  else if (!v.date && V.view === "today" && !isDesktop())   // PM-A⑥；D14：跳过去后新条目短暂高亮
    toast.show("已加入待办", "查看", () => { V.flash.add(r.id); setTimeout(() => { V.flash.delete(r.id); App.ui.render(); }, C.FRESH_MS); App.ui.nav.go("todo"); App.ui.render(); });
  else toast.show("已加入待办", null, null, C.TOAST_MS, {group:"saved"});
}
function onDelete(){
  const it = F.editing, coll = write.collOf(F.origKind || F.kind);
  closeSheet();
  if (!it) return;
  const t = toast.show("已删除 1 项", "撤销", () => write.restore(coll, it), C.TOAST_UNDO_MS);
  write.softDelete(coll, it).then(ok => { if (!ok) toast.dismiss(t); });   // 删除没写进去时，收起“已删除”，只留失败提示
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
  if (globalThis.visualViewport){ visualViewport.addEventListener("resize", fitKeyboard); visualViewport.addEventListener("scroll", fitKeyboard); }
  $("details-toggle").onclick = openDetails;
  $("cancel").onclick = closeSheet; $("scrim").onclick = closeSheet;
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); trapFocus(e); });
  $("del").onclick = onDelete;
  $("sheet").addEventListener("submit", onSubmit);
  $("plus").onclick = () => openSheet(null, null, V.view === "sched" ? V.selDay : null);
}

App.ui.sheet = {open: openSheet, close: closeSheet, isClosed, init, openDetails};
