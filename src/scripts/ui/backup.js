// 职责：待办面板底部的“导出备份（JSON）”和“运行记录”。
//       导出：读出 events、todos、logs 全部数据（含已删除条目，需求澄清 #19），交给 platform/download.js 保存为 .json；
//             用户拒绝或这里不能下载时给出提示，不重试。
//       运行记录（只读）：展开时读取最近 7 天所有设备的日志，列出时间、动作、集合和编号，不显示任何内容（ADR-010）。
// 依赖：core/const.js、core/date.js、data/archive.js、platform/download.js、ui/dom.js、ui/toast.js
// 运行时调用：App.clock
App.ui = App.ui || {};

const C = App.core.C;
const {pad} = App.core.date;
const archive = App.data.archive, download = App.platform.download;
const {$, h} = App.ui.dom;
const toast = App.ui.toast;

const SAVE_ERR = {
  declined: "已取消导出",
  rate_limited: "已经有一个下载在等你确认",
  too_large: "备份太大，暂时导不出来",
  format: "这里不允许下载 JSON 文件",
  unavailable: "这里不能下载文件，可以在 claude.ai 网页里打开再导出",
};
async function exportBackup(){
  const btn = $("export");
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = "正在准备备份…";
  try {
    let data;
    try { data = await archive.backup(App.clock.now()); }
    catch(e){ toast.show("没读到数据，检查网络后再试"); return; }
    const filename = "planner-backup-" + App.clock.today() + ".json";
    try {
      await download.save({filename, data: JSON.stringify(data, null, 2)});
      toast.show("已导出备份：" + data.counts.events + " 项日程、" + data.counts.todos + " 件待办");
    } catch(e){ toast.show(SAVE_ERR[e && e.code] || "没导出成功"); }
  } finally { btn.disabled = false; btn.textContent = "导出备份（JSON）"; }
}

const ACT = {create:"新建", update:"修改", done:"完成", undone:"取消完成", reschedule:"改期", delete:"删除", restore:"恢复",
  purge:"彻底清理", convert:"改类型", ack:"知道了", snooze:"稍后提醒", save_failed:"保存失败", timeout:"超时",
  disconnect:"断线", reconnect:"重新连上", remind_shown:"弹出提醒", remind_ack:"提醒：知道了", remind_snooze:"提醒：10 分钟后"};
const COLL = {events:"日程", todos:"待办", logs:"日志"};
const when = ms => { const d = new Date(ms); return pad(d.getMonth()+1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); };

let logsOpen = false;
async function renderLogs(){
  const list = $("log-list");
  $("log-toggle").setAttribute("aria-expanded", logsOpen ? "true" : "false");
  list.hidden = !logsOpen; list.textContent = "";
  if (!logsOpen) return;
  list.append(h("p",{class:"log-note"},"读取中…"));
  let rows;
  try { rows = await archive.recentLogs(App.clock.today(), C.LOG_VIEW_DAYS); }
  catch(e){ list.textContent = ""; list.append(h("p",{class:"log-note"},"读不到运行记录，检查网络后再试。")); return; }
  if (!logsOpen) return;
  list.textContent = "";
  if (!rows.length){ list.append(h("p",{class:"log-note"},"最近 " + C.LOG_VIEW_DAYS + " 天没有记录。")); return; }
  const ol = h("ol",{class:"log-rows","aria-label":"最近 " + C.LOG_VIEW_DAYS + " 天的运行记录"});
  for (const r of rows){
    ol.append(h("li",{class:"log-row" + (r.kind === "run" ? " run" : "")},
      h("span",{class:"lg-t"}, when(r.t)), h("span",{class:"lg-a"}, ACT[r.act] || r.act),
      h("span",{class:"lg-c"}, COLL[r.coll] || r.coll), h("span",{class:"lg-i"}, r.id ? r.id.slice(0, 10) : "")));
  }
  list.append(ol, h("p",{class:"log-note"},"只记操作类型和编号，不记标题、备注等内容。"));
}
function init(){
  $("export").onclick = exportBackup;
  $("log-toggle").onclick = () => { logsOpen = !logsOpen; renderLogs(); };
}

App.ui.backup = {init, exportBackup};
