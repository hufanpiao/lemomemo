// 写入操作：勾选完成/撤销、改期、全部改到今天、延迟 5 秒的可撤销删除；先改本地再写存储，失败回滚并提示重试。
// 页面隐藏或关闭时立即提交待删除项。
// 依赖：core/date.js、data/store.js、data/state.js；调用时用到 ui/toast.js、ui/render.js。
App.data = App.data || {};

const {ymd, today, addDays} = App.core.date;
const store = App.data.store, S = App.data.state;
const toast = (...a) => App.ui.toast.show(...a);
const render = () => App.ui.render();

function errMsg(e){ return e && e.code === "invalid_argument" ? "你没有修改权限，只能查看。" : e && e.code === "quota_exceeded" ? "存储已满，删掉一些旧条目再试。" : "没保存上，检查网络后再试。"; }
async function write(fn, onFail){
  try { await fn(); return true; }
  catch(e){ if (onFail) onFail(); toast(errMsg(e), "重试", () => write(fn, onFail), 6000); render(); return false; }
}
function toggleDone(x, done, li){
  const prev = {done:x.done, doneAt:x.doneAt};
  x.done = done; x.doneAt = done ? Date.now() : 0;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (li){
    li.classList.toggle("done", done);
    S.holdUntil = Date.now() + (done ? (reduce ? 800 : 960) : 0);
  }
  if (!li) render(); else setTimeout(render, done ? (reduce ? 800 : 960) : 0);
  write(() => store.update("todos", x.id, {done, doneAt:x.doneAt, updatedAt:Date.now()}), () => { x.done = prev.done; x.doneAt = prev.doneAt; S.holdUntil = 0; });
  if (done) {
    const n = App.data.visTd().filter(y => y.done && y.doneAt && ymd(new Date(y.doneAt)) === today()).length;
    toast("完成了，今天第 "+n+" 件", "撤销", () => toggleDone(x, false, null), 3500);
  }
}
function reschedule(x, d){
  const prev = x.due; x.due = d; render();
  write(() => store.update("todos", x.id, {due:d, updatedAt:Date.now()}), () => { x.due = prev; });
  toast("已改到"+(d === today() ? "今天" : "明天"));
}
async function moveAll(list){
  const t = today(), prev = list.map(x => [x, x.due]);
  list.forEach(x => x.due = t); render();
  for (const [x] of prev) await write(() => store.update("todos", x.id, {due:t, updatedAt:Date.now()}), () => { x.due = prev.find(p => p[0]===x)[1]; });
  toast(list.length+" 件已改到今天");
}
function scheduleDelete(coll, item){
  const timer = setTimeout(() => commitDelete(item.id), 5000);
  S.pendingDel.set(item.id, {coll, timer});
  render();
  toast("已删除“"+(item.title.length > 12 ? item.title.slice(0,12)+"…" : item.title)+"”", "撤销", () => {
    const p = S.pendingDel.get(item.id); if (p){ clearTimeout(p.timer); S.pendingDel.delete(item.id); render(); }
  }, 5000);
}
function commitDelete(id){
  const p = S.pendingDel.get(id); if (!p) return;
  clearTimeout(p.timer);
  write(() => store.remove(p.coll, id).then(() => S.pendingDel.delete(id)), () => { S.pendingDel.delete(id); });
}
function flushDeletes(){ for (const id of [...S.pendingDel.keys()]) commitDelete(id); }
function init(){
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushDeletes(); });
  window.addEventListener("pagehide", flushDeletes);
}

App.data.write = {write, toggleDone, reschedule, moveAll, scheduleDelete, commitDelete, flushDeletes, init};
