// 职责：待办页顶部的搜索：在标题、备注、原话里找，范围包括已完成的待办和过去的日程（不含已删除，不受项目筛选影响）。
//       有结果时显示“N 条”并高亮关键词，结果替换掉原来的列表；没结果时显示“没找到”和“清空”按钮；清空或按 Esc 回到原列表。
// 依赖：core/const.js、logic/search.js、data/state.js、ui/dom.js
// 运行时调用：ui/todos.js、ui/schedule.js
App.ui = App.ui || {};

const C = App.core.C;
const {search} = App.logic.search;
const visEv = App.data.visEv, visTd = App.data.visTd;
const {$, h} = App.ui.dom;

let q = "";
const active = () => !!q.trim();
function clear(){ q = ""; $("search").value = ""; render(); $("search").focus(); }

function render(){
  const box = $("search-res"), main = $("td-main");
  box.textContent = "";
  box.hidden = !active(); main.hidden = active();
  if (!active()) return;
  const res = search(visEv(), visTd(), q, C.SEARCH_MAX);
  if (!res.length){
    box.append(h("div",{class:"empty search-none"}, h("strong",null,"没找到"), "换个词试试，也可以在聊天里让 Claude 帮你找。",
      h("button",{class:"btn-clear",type:"button",onclick:clear},"清空")));
    return;
  }
  box.append(h("div",{class:"res-n",role:"status"}, h("span",null, res.length + " 条"), h("button",{class:"btn-clear",type:"button",onclick:clear},"清空")));
  const ul = h("ul",{class:"todos"}), ev = h("div",{class:"evlist"});
  for (const r of res){
    if (r.kind === "todo") ul.append(App.ui.todos.row(r.item, {q}));
    else ev.append(App.ui.schedule.evBlock(r.item, {q, showDate:true}));
  }
  if (ul.childNodes.length) box.append(ul);
  if (ev.childNodes.length) box.append(ev);
}
function init(){
  $("search").oninput = () => { q = $("search").value; render(); };
  $("search").onkeydown = e => { if (e.key === "Escape" && active()){ e.preventDefault(); e.stopPropagation(); clear(); } };
}

App.ui.search = {init, render, clear, active};
