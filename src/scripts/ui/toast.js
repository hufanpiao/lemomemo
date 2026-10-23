// 职责：底部提示条队列（采纳结论 #11、UI-4⑤）：show(文案, 按钮字, 按钮动作, 显示毫秒, 选项) 新增一条并返回句柄，dismiss(句柄) 收起。
//       左对齐、宽度统一，最多叠 TOAST_MAX 条，每条单独计时；ms 传 0 表示不自动消失（带“重试”的失败提示），这时多一个 44px 的关闭按钮。
//       第 4 条进来时最旧的让位；被挤掉的是删除提示（选项 kind:"delete"，或文案以“已删除”开头）时，新提示里写明“更早删除的在最近删除里”。
//       位置变化用 FLIP 平移 180ms（减少动效时不做位移）。
// 依赖：core/const.js、ui/dom.js
App.ui = App.ui || {};

const C = App.core.C;
const {$, h} = App.ui.dom;
const live = [];   // 当前显示中的提示：{el, timer, kind}
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// 先记下各条的位置，改完 DOM 后把位移“倒放”回去（FLIP）
function flip(mutate){
  const els = [...$("toasts").children];
  const before = new Map(els.map(el => [el, el.getBoundingClientRect().top]));
  mutate();
  if (reduced()) return;
  for (const [el, top] of before){
    if (!el.isConnected || !el.animate) continue;
    const dy = top - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) el.animate([{translate:"0 " + dy + "px"}, {translate:"0 0"}], {duration:C.TOAST_FLIP_MS, easing:"cubic-bezier(.22,1,.36,1)"});
  }
}
function dismiss(t){
  const i = live.indexOf(t); if (i < 0) return;
  live.splice(i, 1);
  clearTimeout(t.timer);
  t.el.classList.remove("on");
  setTimeout(() => flip(() => t.el.remove()), C.TOAST_LEAVE_MS);
}
// opts：{kind:"delete"} 标明是删除提示
function show(msg, btnText, action, ms, opts){
  const o = opts || {};
  const t = {el:null, timer:null, kind: o.kind || (/^已删除/.test(msg) ? "delete" : "")};
  let pushedOutDelete = false;
  while (live.length >= C.TOAST_MAX){ if (live[0].kind === "delete") pushedOutDelete = true; dismiss(live[0]); }
  const sticky = ms === 0;
  const btn = btnText ? h("button",{type:"button",class:"tb-act",onclick:() => { dismiss(t); if (action) action(); }}, btnText) : null;
  const close = sticky ? h("button",{type:"button",class:"tb-x","aria-label":"关闭提示",onclick:() => dismiss(t)}, "×") : null;
  t.el = h("div",{class:"toast" + (sticky ? " sticky" : "")},
    h("span",{class:"tm"}, msg, pushedOutDelete ? h("small",null,"更早删除的在“最近删除”里") : null),
    h("span",{class:"tbs"}, btn, close));
  flip(() => $("toasts").append(t.el));
  live.push(t);
  requestAnimationFrame(() => t.el.classList.add("on"));
  if (!sticky) t.timer = setTimeout(() => dismiss(t), ms || C.TOAST_MS);
  return t;
}

App.ui.toast = {show, dismiss};
