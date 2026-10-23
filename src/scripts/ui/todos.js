// “待办”视图：项目筛选胶囊、未完成 + 今天完成的列表、折叠的更早已完成；row() 生成一行待办（勾选、标签），今天视图也复用。
// 依赖：core/date.js、core/dom.js、logic/projects.js、logic/sort.js、logic/format.js、data/state.js、data/write.js；
//       调用时用到 ui/sheet.js。
App.ui = App.ui || {};

const {ymd, today, dayDiff} = App.core.date;
const {$, h, ICON_CHECK, skeleton, emptyBox} = App.core.dom;
const {projColor} = App.logic.projects;
const {sortTodos} = App.logic.sort;
const {dueText} = App.logic.format;
const S = App.data.state, visTd = App.data.visTd, ready = App.data.ready;
const {toggleDone} = App.data.write;
const openSheet = (...a) => App.ui.sheet.open(...a);

function todoRow(x){
  const t = today();
  const li = h("li",{class:"td"+(x.done?" done":"")+(x.important?" imp":"")+(S.fresh.has(x.id)?" fresh":""),"data-id":x.id});
  const ck = h("button",{class:"ck",type:"button","aria-pressed":x.done?"true":"false","aria-label":(x.done?"标为未完成：":"完成：")+x.title}, h("span",{html:ICON_CHECK}));
  ck.onclick = () => toggleDone(x, !x.done, li);
  const tags = h("span",{class:"tags"});
  if (x.project) tags.append(h("span",{class:"tag"}, h("span",{class:"sw",style:"background:"+projColor(x.project)}), x.project));
  if (x.due && !x.done){
    const n = dayDiff(x.due, t);
    tags.append(h("span",{class:"tag"+(n<0?" over":n===0?" due-today":"")}, dueText(x.due)));
  }
  if (x.source === "chat") tags.append(h("span",{class:"tag ai"},"Claude 代记"));
  const body = h("button",{class:"tb",type:"button",onclick:()=>openSheet("todo",x)}, h("span",{class:"tt"},x.title), tags.childNodes.length ? tags : null);
  li.append(ck, body);
  return li;
}
function renderTodos(){
  const f = $("filters"); f.textContent = "";
  const open = visTd().filter(x => !x.done);
  const ps = [...new Set(visTd().map(x => x.project).filter(Boolean))];
  if (S.projFilter && !ps.includes(S.projFilter)) S.projFilter = null;
  if (ps.length){
    f.append(h("button",{class:"f",type:"button","aria-pressed":!S.projFilter?"true":"false",onclick:()=>{S.projFilter=null;renderTodos();}},"全部"));
    ps.forEach(p => f.append(h("button",{class:"f",type:"button","aria-pressed":S.projFilter===p?"true":"false",onclick:()=>{S.projFilter=p;renderTodos();}},
      h("span",{class:"sw",style:"background:"+projColor(p)}), p)));
  }
  f.hidden = !ps.length;
  const ul = $("todos"); ul.textContent = "";
  const t = today();
  const inScope = x => !S.projFilter || x.project === S.projFilter;
  const list = sortTodos(visTd().filter(x => inScope(x) && (!x.done || (x.doneAt && ymd(new Date(x.doneAt)) === t))));
  $("td-meta").textContent = open.filter(inScope).length ? open.filter(inScope).length+" 件未完成" : "";
  if (!ready()) ul.append(...skeleton(3));
  else if (!list.length){
    const doneAll = visTd().some(x => x.done && inScope(x));
    ul.append(h("li",null, doneAll ? emptyBox("全部做完了", "新的待办点右下角的＋添加。") : emptyBox("没有待办", "点右下角的＋，写一句话，比如“周五前交 NEOX 横版”。")));
  } else list.forEach(x => ul.append(todoRow(x)));
  const old = sortTodos(visTd().filter(x => inScope(x) && x.done && !(x.doneAt && ymd(new Date(x.doneAt)) === t)));
  const tg = $("done-toggle"), dlist = $("done-list");
  tg.hidden = !old.length;
  tg.textContent = S.showDone ? "收起已完成" : "已完成 "+old.length+" 件";
  dlist.hidden = !S.showDone || !old.length; dlist.textContent = "";
  if (S.showDone) old.slice(0,100).forEach(x => dlist.append(todoRow(x)));
}
function init(){
  $("done-toggle").onclick = () => { S.showDone = !S.showDone; renderTodos(); };
}

App.ui.todos = {render: renderTodos, row: todoRow, init};
