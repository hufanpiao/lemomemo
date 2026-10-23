// 职责：【v3 预留，尚未实现】深色 / 浅色切换：抬头右上角的圆形按钮，在“跟随系统 → 浅色 → 深色”之间切换，
//       选择存在本机偏好 pv-theme；通过给 <html> 设 data-theme="light"|"dark"（跟随系统时去掉）生效，
//       tokens.css 已经支持这两种写法。
// 依赖：platform/prefs.js
App.ui = App.ui || {};

/*
 * 计划接口：
 *   init()        启动时读 prefs.get(prefs.KEYS.theme, "system") 并应用；绑定按钮
 *   cycle()       system → light → dark → system，保存并应用
 *   apply(mode)   mode = "system" | "light" | "dark"
 */
App.ui.theme = {
  init(){},   // v3 实现
};
