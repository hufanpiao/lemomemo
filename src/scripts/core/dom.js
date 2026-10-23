// DOM 小工具：$(id) 取元素、h() 一次建好带属性和子节点的元素、对勾图标、骨架和空状态框。
// 只在函数被调用时才访问 document，加载本文件本身不需要页面。
// 依赖：无。
App.core = App.core || {};

const $ = id => document.getElementById(id);
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
function h(tag, attrs, ...kids){
  const el = document.createElement(tag);
  for (const k in (attrs||{})){
    const v = attrs[k]; if (v == null || v === false) continue;
    if (k === "class") el.className = v; else if (k === "style") el.setAttribute("style", v);
    else if (k.startsWith("on")) el[k] = v; else if (k === "html") el.innerHTML = v; else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()){ if (c == null || c === false) continue; el.append(c.nodeType ? c : String(c)); }
  return el;
}
function skeleton(n){ return Array.from({length:n}, () => h("div",{class:"sk"})); }
function emptyBox(title, text){ return h("div",{class:"empty"}, h("strong",null,title), text); }

App.core.dom = {$, h, ICON_CHECK, skeleton, emptyBox};
