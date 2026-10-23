// @fixture 路径=src/scripts/logic/ok-mentions.js 期望=无
// 职责：合规示例：字符串和注释里提到 App.ui、document、localStorage、window.claude、Date.now() 都不算违规
// 依赖：无
App.logic = App.logic || {};
// 这里的注释写了 App.ui.toast、document、localStorage、window.claude、Date.now()，不算违规
const TIPS = ["界面层是 App.ui", "不要在 logic 里用 document 或 new Date()", '也不要碰 localStorage 和 window.claude', `Date.now() 由参数传入`];
App.logic.okMentions = (t) => TIPS.length + t.length;
