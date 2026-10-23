// 职责：日程页和待办页共用的项目筛选（需求澄清 #21：今天页不筛选）。render(容器 id) 画“全部 + 各项目”胶囊，
//       点了改 V.projFilter 后整页重绘，两页同时生效；inScope(x) 判断条目是否在筛选范围内。
//       项目名单取自未删除的日程和待办；筛选的项目不见了就自动回到“全部”。另含 bellTag()、hl() 两个列表共用的小部件。
// 依赖：logic/projects.js、logic/remind.js、logic/search.js、data/state.js、ui/dom.js、ui/view-state.js
// 运行时调用：ui/render.js
App.ui = App.ui || {};

const {projColor} = App.logic.projects;
const remind = App.logic.remind, {segments} = App.logic.search;
const visEv = App.data.visEv, visTd = App.data.visTd;
const {$, h} = App.ui.dom;
const V = App.ui.view;

const names = () => [...new Set(visEv().map(e => e.project).concat(visTd().map(x => x.project)).filter(Boolean))];
const inScope = x => !V.projFilter || x.project === V.projFilter;
function set(p){ V.projFilter = p; App.ui.render(); }
function render(id){
  const f = $(id); f.textContent = "";
  const ps = names();
  if (V.projFilter && !ps.includes(V.projFilter)) V.projFilter = null;
  f.hidden = !ps.length;
  if (!ps.length) return;
  f.append(h("button",{class:"f",type:"button","aria-pressed":!V.projFilter?"true":"false",onclick:()=>set(null)},"全部"));
  ps.forEach(p => f.append(h("button",{class:"f",type:"button","aria-pressed":V.projFilter===p?"true":"false",onclick:()=>set(p)},
    h("span",{class:"sw",style:"background:"+projColor(p)}), p)));
}

const BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>';
// 铃铛标签：提醒设置的文字（“提前 15 分”“前一天 9:00”）；不提醒或已完成时返回 null
function bellTag(item, kind, cls){
  if (item.done) return null;
  const text = remind.label(item, kind);
  return text ? h("span",{class:(cls || "tag") + " bell","aria-label":"提醒："+text}, h("span",{class:"bi","aria-hidden":"true",html:BELL}), text) : null;
}
// 关键词高亮：把文字切成普通文字和 <mark>（只用文本节点，不拼 HTML）
function hl(text, q){ return segments(text, q).map(s => s.hit ? h("mark",null,s.text) : s.text); }

App.ui.filter = {render, inScope, names, bellTag, hl};
