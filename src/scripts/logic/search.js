// 职责：搜索（纯函数）：search(events, todos, q) 在标题、备注、原话里找关键词（不分大小写，中文、韩文按原样匹配），
//       范围包括已完成的待办和过去的日程；调用方传入的应是未删除的条目。结果先列待办（未完成在前），再列日程（新的在前）。
//       segments(text, q) 把一段文字切成 [{text, hit}]，界面据此高亮关键词（不拼 HTML）。
// 依赖：logic/sort.js
App.logic = App.logic || {};

const {sortTodos} = App.logic.sort;
const FIELDS = ["title", "note", "rawText"];
const norm = s => String(s == null ? "" : s).toLowerCase();

function matches(x, q){ return FIELDS.some(f => norm(x[f]).includes(q)); }

// 返回 [{kind:"todo"|"event", item}]；q 为空时返回 []
function search(events, todos, q, max){
  const k = norm(q).trim();
  if (!k) return [];
  const td = sortTodos(todos.filter(x => matches(x, k)));
  const ev = events.filter(e => matches(e, k)).sort((a,b) => (b.date + (b.time || "")).localeCompare(a.date + (a.time || "")));
  const out = td.map(item => ({kind:"todo", item})).concat(ev.map(item => ({kind:"event", item})));
  return max ? out.slice(0, max) : out;
}
// 文字里出现关键词的地方标 hit:true；没有关键词时整段 hit:false
function segments(text, q){
  const s = text == null ? "" : String(text), k = norm(q).trim();
  if (!k) return [{text:s, hit:false}];
  const low = s.toLowerCase(), out = [];
  let i = 0, j;
  while ((j = low.indexOf(k, i)) >= 0){
    if (j > i) out.push({text:s.slice(i, j), hit:false});
    out.push({text:s.slice(j, j + k.length), hit:true});
    i = j + k.length;
  }
  if (i < s.length) out.push({text:s.slice(i), hit:false});
  return out.length ? out : [{text:s, hit:false}];
}

App.logic.search = {search, segments, matches};
