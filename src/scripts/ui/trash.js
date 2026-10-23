// 职责：待办页的“最近删除”：默认折叠成一行色块“最近删除 N 件  30 天后自动清理 ›”（采纳结论 #9），展开后每条显示
//       标题、类型、“N 天前删除”和“恢复”按钮；恢复时这一行先淡出，条目回到原位并用 .fresh 短暂高亮（TC-DEL-09）。
//       断网或没连上数据时“恢复”置灰（TC-DEL-19），恢复网络后自动可用。
// 依赖：core/const.js、data/state.js、data/write.js、data/archive.js、ui/dom.js、ui/view-state.js
// 运行时调用：ui/render.js、App.clock
App.ui = App.ui || {};

const C = App.core.C;
const write = App.data.write, archive = App.data.archive;
const {$, h} = App.ui.dom;
const V = App.ui.view;

let open = false;
const online = () => navigator.onLine !== false && App.data.isConnected();
function ago(ms){
  const d = Math.floor((App.clock.now() - ms) / C.DAY_MS);
  return d <= 0 ? "今天删除" : d + " 天前删除";
}
function restore(r, row){
  row.classList.add("leaving");
  setTimeout(() => {
    const id = r.item.id;
    V.flash.add(id);
    setTimeout(() => { V.flash.delete(id); }, C.FRESH_MS);
    write.restore(r.coll, r.item);
  }, 160);   // 与 trash.css 的 .trash-row.leaving 动画 .16s 一致（UI-4）
}
function render(){
  const btn = $("trash-toggle"), list = $("trash-list"), items = archive.trash();
  btn.hidden = !items.length;
  if (!items.length){ open = false; list.hidden = true; list.textContent = ""; return; }
  btn.textContent = "";
  btn.append(h("span",null, h("b",null,"最近删除 " + items.length + " 件"), "  " + C.TRASH_KEEP_DAYS + " 天后自动清理"), h("span",{class:"chev","aria-hidden":"true"},"›"));
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  list.hidden = !open; list.textContent = "";
  if (!open) return;
  const ok = online();
  if (!ok) list.append(h("p",{class:"trash-off"},"网络断开了，恢复网络后才能恢复条目。"));
  for (const r of items){
    const row = h("div",{class:"trash-row"},
      h("span",{class:"tr-b"}, h("span",{class:"tr-t"}, r.item.title || "（没有标题）"),
        h("span",{class:"tr-m"}, (r.kind === "event" ? "日程" : "待办") + " · " + ago(r.item.deletedAt))),
      h("button",{class:"restore",type:"button",disabled:!ok,"aria-label":"恢复：" + (r.item.title || "没有标题的条目")},"恢复"));
    row.querySelector(".restore").onclick = () => restore(r, row);
    list.append(row);
  }
}
function init(){
  $("trash-toggle").onclick = () => { open = !open; render(); };
  addEventListener("online", render); addEventListener("offline", render);
}

App.ui.trash = {init, render};
