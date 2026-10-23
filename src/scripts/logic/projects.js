// 职责：项目颜色与项目列表（纯函数）：已知项目用固定马卡龙色，其他项目按名字哈希取色；
//       projectList() 汇总已知项目和传入条目里出现过的项目（保持出现顺序；调用方传入的应是未删除的条目）。
// 依赖：无
App.logic = App.logic || {};

const KNOWN = {"SignPlex":"--p5","NEOX":"--p1","SOIL STUDIO":"--p4"};
const PAL = ["--p2","--p3","--p6","--p5","--p1","--p4"];
function projVar(p){
  if (!p) return "--p7";
  for (const k in KNOWN) if (k.toLowerCase() === p.toLowerCase()) return KNOWN[k];
  let x = 0; for (const c of p) x = (x*31 + c.charCodeAt(0)) >>> 0;
  return PAL[x % PAL.length];
}
const projColor = p => "var(" + projVar(p) + ")";
function projectList(events, todos){
  const set = new Set(Object.keys(KNOWN));
  for (const x of events.concat(todos)) if (x.project) set.add(x.project);
  return [...set];
}

App.logic.projects = {KNOWN, PAL, projVar, projColor, projectList};
