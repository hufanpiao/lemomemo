// 职责：本机偏好（localStorage）的唯一入口：get(键, 默认值)、set(键, 值)。读写失败（隐私模式、被禁用）时静默用默认值。
//       全部键名集中登记在 KEYS 里，新加偏好先在这里登记，并同步 docs/05-数据字典/数据字典.md 的“本机存储”。
// 依赖：platform/index.js
App.platform = App.platform || {};

const KEYS = {
  view: "pv-view",     // 上次打开的视图：today / sched / todo（v2 起）
  theme: "pv-theme",   // v3：深浅色 system / light / dark（ADR-008）
  skin: "pv-skin",     // v3：皮肤，目前只有 bento（ADR-008）
  device: "pv-device", // v3：本机设备号，运行日志用（ADR-010）
  purged: "pv-purged", // v3：上次清理过期日志和最近删除的日期（每天最多一次）
};
function get(key, fallback){
  try { const v = localStorage.getItem(key); return v == null || v === "" ? fallback : v; }
  catch(e){ return fallback; }
}
function set(key, value){
  try { localStorage.setItem(key, value); } catch(e){}
}

// 本机设备号：第一次用时随机生成并保存；存不下（隐私模式）时每次打开都是新的，不影响功能
function deviceId(){
  let id = get(KEYS.device, "");
  if (!id){
    const r = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2);
    id = "d-" + r.replace(/-/g, "").slice(0, 10);
    set(KEYS.device, id);
  }
  return id;
}

App.platform.prefs = {KEYS, get, set, deviceId};
