// 职责：【v3 预留，尚未实现】页面开着时的提醒：每次时钟 tick 检查到点的条目，在顶部弹提醒卡片
//       （“知道了” / “10 分钟后再提醒”），并调用 platform/notify.js 响提示音。
// 依赖：platform/notify.js、ui/dom.js
// 运行时调用：data/write.js（写 notifiedFor / snoozeAt）、logic/remind.js、App.clock
App.ui = App.ui || {};

/*
 * 计划接口：
 *   init()          在 app.js 里调用；订阅 App.clock 的 "tick" 和 "wake"
 *   check(now)      找出 remindAt（或 snoozeAt）≤ now 且 notifiedFor ≠ remindAt 的条目，逐个弹卡片
 *   卡片按钮：“知道了” → data/write.js 写 notifiedFor = remindAt；
 *             “10 分钟后再提醒” → 写 snoozeAt = now + 10 分钟
 *   提醒卡片的文案可以带完整标题（只在本机屏幕上显示）；推送文字要脱敏，见 platform/notify.js。
 */
App.ui.remind = {
  init(){},   // v3 实现
};
