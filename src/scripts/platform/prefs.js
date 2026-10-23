// 职责：本机偏好（localStorage）的唯一入口：get(键, 默认值)、set(键, 值)。读写失败（隐私模式、被禁用）时静默用默认值。
//       全部键名集中登记在 KEYS 里，新加偏好先在这里登记，并同步 docs/05-数据字典/数据字典.md 的“本机存储”。
// 依赖：platform/index.js
App.platform = App.platform || {};

const KEYS = {
  view: "pv-view",     // 上次打开的视图：today / sched / todo（v2 起）
  theme: "pv-theme",   // 【v3 预留】主题：system / light / dark
};
function get(key, fallback){
  try { const v = localStorage.getItem(key); return v == null || v === "" ? fallback : v; }
  catch(e){ return fallback; }
}
function set(key, value){
  try { localStorage.setItem(key, value); } catch(e){}
}

App.platform.prefs = {KEYS, get, set};
