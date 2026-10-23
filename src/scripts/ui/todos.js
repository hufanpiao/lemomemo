// 职责：“待办”视图：项目筛选胶囊（与日程页共用）、未完成 + 今天完成的列表、折叠的更早已完成；row() 生成一行待办
//       （勾选、项目、截止、铃铛标签，可高亮搜索关键词），toggle() 是勾选的统一入口（今天视图的大卡片、日程页截止行也用）：
//       写入后提示“今天第 N 件”并可撤销；toggleInList() 在列表里勾选时先播完划线动画再重排。
//       搜索、最近删除、运行记录和导出分别在 ui/search.js、ui/trash.js、ui/backup.js，这里按顺序调用。
// 依赖：core/const.js、core/date.js、logic/items.js、logic/projects.js、logic/sort.js、logic/format.js、
//       data/state.js、data/write.js、ui/dom.js、ui/view-state.js、ui/toast.js、ui/filter.js
// 运行时调用：ui/sheet.js、ui/search.js、ui/trash.js、App.clock
App.ui = App.ui || {};

const C = App.core.C;
const {isDoneOn} = App.logic.items;
const {projColor} = App.logic.projects;
const {sortTodos} = App.logic.sort;
const {dueText} = App.logic.format;
const S = App.data.state, visTd = App.data.visTd, ready = App.data.ready, write = App.data.write;
const {$, h, ICON_CHECK, skeleton, emptyBox} = App.ui.dom;
const V = App.ui.view, toast = App.ui.toast, filter = App.ui.filter;
const {dayDiff} = App.core.date;
const openSheet = (...a) => App.ui.sheet.open(...a);

function toggle(x, done){
  write.toggleDone(x, done);
  if (done){
    const t = App.clock.today();
    const n = visTd().filter(y => isDoneOn(y, t)).length;
    toast.show("完成了，今天第 "+n+" 件", "撤销", () => toggle(x, false), C.TOAST_UNDO_MS);
  }
}
// 列表里勾选：先让这一行（待办行或日程页截止行）播完划线动画（holdUntil 期间暂缓重绘），再重排
function toggleInList(x, li){
  const done = !x.done;
  li.classList.toggle("done", done);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  V.holdUntil = App.clock.now() + (done ? (reduce ? C.DONE_ANIM_REDUCED_MS : C.DONE_ANIM_MS) : 0);
  toggle(x, done);
}

// opts：{q 高亮搜索关键词}
function todoRow(x, opts){
  const o = opts || {}, t = App.clock.today();
  const li = h("li",{class:"td"+(x.done?" done":"")+(x.important?" imp":"")+(S.fresh.has(x.id) || V.flash.has(x.id) ?" fresh":""),"data-id":x.id});
  const ck = h("button",{class:"ck",type:"button","aria-pressed":x.done?"true":"false","aria-label":(x.done?"标为未完成：":"完成：")+x.title}, h("span",{html:ICON_CHECK}));
  ck.onclick = () => toggleInList(x, li);
  const tags = h("span",{class:"tags"});
  if (x.project) tags.append(h("span",{class:"tag"}, h("span",{class:"sw",style:"background:"+projColor(x.project)}), x.project));
  if (x.due && !x.done){
    const n = dayDiff(x.due, t);
    tags.append(h("span",{class:"tag"+(n<0?" over":n===0?" due-today":"")}, dueText(x.due, t)));
  }
  const bell = filter.bellTag(x, "todo");
  if (bell) tags.append(bell);
  if (x.source === "chat") tags.append(h("span",{class:"tag ai"},"Claude 代记"));
  if (o.q && x.note) tags.append(h("span",{class:"tag note"}, filter.hl(x.note, o.q)));
  const body = h("button",{class:"tb",type:"button",onclick:()=>openSheet("todo",x)}, h("span",{class:"tt"}, o.q ? filter.hl(x.title, o.q) : x.title), tags.childNodes.length ? tags : null);
  li.append(ck, body);
  return li;
}
function renderTodos(){
  filter.render("filters");
  const ul = $("todos"); ul.textContent = "";
  const t = App.clock.today();
  const inScope = filter.inScope;
  const open = visTd().filter(x => !x.done && inScope(x));
  const list = sortTodos(visTd().filter(x => inScope(x) && (!x.done || isDoneOn(x, t))));
  $("td-meta").textContent = open.length ? open.length+" 件未完成" : "";
  if (!ready()) ul.append(...skeleton(3));
  else if (!list.length){
    const doneAll = visTd().some(x => x.done && inScope(x));
    ul.append(h("li",null, doneAll ? emptyBox("全部做完了", "新的待办点右下角的＋添加。") : emptyBox("没有待办", "点右下角的＋，写一句话，比如“周五前交 NEOX 横版”。")));
  } else list.forEach(x => ul.append(todoRow(x)));
  const old = sortTodos(visTd().filter(x => inScope(x) && x.done && !isDoneOn(x, t)));
  const tg = $("done-toggle"), dlist = $("done-list");
  tg.hidden = !old.length;
  tg.textContent = V.showDone ? "收起已完成" : "已完成 "+old.length+" 件";
  dlist.hidden = !V.showDone || !old.length; dlist.textContent = "";
  if (V.showDone) old.slice(0, C.OLD_DONE_MAX).forEach(x => dlist.append(todoRow(x)));
  App.ui.search.render();
  App.ui.trash.render();
}
function init(){
  $("done-toggle").onclick = () => { V.showDone = !V.showDone; renderTodos(); };
}

App.ui.todos = {render: renderTodos, row: todoRow, toggle, toggleInList, init};
