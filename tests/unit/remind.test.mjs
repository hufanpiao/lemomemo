// 职责：提醒规则 logic/remind.js 的单元测试。“今天”是 2026-10-23（周五），时间都是本地时间。
//       覆盖：默认值（需求澄清 #1、#2）、提醒时刻计算、snoozeAt（#4、#28）、该不该提醒（#3、#5、#30）、去重、选项和标签。
// 依赖：tests/lib/harness.mjs、src/scripts/core/const.js、core/date.js、logic/remind.js
import assert from "node:assert/strict";
import { loadApp, src, plain, test, done } from "../lib/harness.mjs";

const ctx = loadApp([src("core/const.js"), src("core/date.js"), src("logic/remind.js")]);
const R = ctx.App.logic.remind;
const at = (d, hm) => { const [h, m] = hm.split(":").map(Number); return ctx.App.core.date.msAt(d, h * 60 + m); };
const MIN = 60000;

const ev = o => Object.assign({date:"2026-10-23", time:"14:30", durationMin:60, deletedAt:null}, o);
const allday = o => Object.assign({date:"2026-10-25", time:"", durationMin:60, deletedAt:null}, o);
const td = o => Object.assign({due:"2026-10-24", done:false, important:false, deletedAt:null}, o);

// —— 默认值 ——
test("有时间的日程缺 remindMin 时默认提前 15 分钟", () => assert.equal(R.computeRemindAt(ev({}), "event"), at("2026-10-23", "14:15")));
test("全天日程缺 remindDays 时默认前一天 20:00", () => assert.equal(R.computeRemindAt(allday({}), "event"), at("2026-10-24", "20:00")));
test("待办缺 remindDays 时默认截止当天 9:00", () => assert.equal(R.computeRemindAt(td({}), "todo"), at("2026-10-24", "09:00")));
test("标了重要的待办默认前一天 9:00", () => assert.equal(R.computeRemindAt(td({important:true}), "todo"), at("2026-10-23", "09:00")));

// —— 各个选项 ——
for (const [min, want] of [[0, "14:30"], [15, "14:15"], [30, "14:00"], [60, "13:30"]])
  test(`日程提前 ${min} 分钟`, () => assert.equal(R.computeRemindAt(ev({remindMin:min}), "event"), at("2026-10-23", want)));
test("日程提前 1 天（1440 分钟）", () => assert.equal(R.computeRemindAt(ev({remindMin:1440}), "event"), at("2026-10-22", "14:30")));
test("全天日程选“当天 9:00”", () => assert.equal(R.computeRemindAt(allday({remindDays:0}), "event"), at("2026-10-25", "09:00")));
test("待办选“前一天 9:00”", () => assert.equal(R.computeRemindAt(td({remindDays:1}), "todo"), at("2026-10-23", "09:00")));
test("选了不提醒（null）就没有提醒", () => {
  assert.equal(R.computeRemindAt(ev({remindMin:null}), "event"), null);
  assert.equal(R.computeRemindAt(allday({remindDays:null}), "event"), null);
  assert.equal(R.computeRemindAt(td({remindDays:null}), "todo"), null);
});
test("待办没有截止日不提醒", () => assert.equal(R.computeRemindAt(td({due:""}), "todo"), null));
test("已完成的待办不提醒", () => assert.equal(R.computeRemindAt(td({done:true}), "todo"), null));
test("已删除的条目不提醒", () => {
  assert.equal(R.computeRemindAt(ev({deletedAt:1}), "event"), null);
  assert.equal(R.computeRemindAt(td({deletedAt:1}), "todo"), null);
});
test("跨月：11月1日的全天日程，前一天是10月31日", () => assert.equal(R.computeRemindAt(allday({date:"2026-11-01"}), "event"), at("2026-10-31", "20:00")));

// —— 稍后再提醒 ——
test("snoozeAt 晚于规则时刻时，以 snoozeAt 为准", () => {
  const s = at("2026-10-23", "14:25");
  assert.equal(R.computeRemindAt(ev({snoozeAt:s}), "event"), s);
});
test("snoozeAt 早于规则时刻时，以规则时刻为准", () => assert.equal(R.computeRemindAt(ev({snoozeAt:at("2026-10-23", "10:00")}), "event"), at("2026-10-23", "14:15")));
test("只改标题、备注、项目时保留 snoozeAt（#28）", () => {
  const before = ev({title:"a", note:"", project:""});
  assert.equal(R.shouldResetSnooze(before, {title:"b", note:"x", project:"NEOX"}), false);
});
test("改了日期、时间或提醒选项时清空 snoozeAt（#28）", () => {
  const before = ev({});
  assert.equal(R.shouldResetSnooze(before, {time:"15:00"}), true);
  assert.equal(R.shouldResetSnooze(before, {date:"2026-10-24"}), true);
  assert.equal(R.shouldResetSnooze(before, {remindMin:30}), true);
  assert.equal(R.shouldResetSnooze(before, {time:"14:30"}), false, "值没变不算改");
});

// —— 现在该不该提醒 ——
const e1 = ev({});   // 提醒时刻 14:15，开始 14:30，结束 15:30
test("没到提醒时刻：不提醒", () => assert.equal(R.due(e1, "event", at("2026-10-23", "14:14"), 0), null));
test("到了提醒时刻：提醒", () => assert.deepEqual(plain(R.due(e1, "event", at("2026-10-23", "14:15"), 0)), {at: at("2026-10-23", "14:15")}));
test("提醒时刻已过、但还没开始：照样提醒（#3）", () => assert.ok(R.due(e1, "event", at("2026-10-23", "14:28"), 0)));
test("已经开始但没结束、也在 60 分钟内：仍提醒", () => assert.ok(R.due(e1, "event", at("2026-10-23", "14:40"), 0)));
test("日程已经结束：不提醒", () => assert.equal(R.due(ev({remindMin:0, durationMin:30}), "event", at("2026-10-23", "15:01"), 0), null));
test("过了提醒时刻 60 分钟以上：不再补发（#30）", () => assert.equal(R.due(td({}), "todo", at("2026-10-24", "10:01"), 0), null));
test("刚好 60 分钟：还提醒", () => assert.ok(R.due(td({}), "todo", at("2026-10-24", "10:00"), 0)));
test("已经提醒过（notifiedFor 等于提醒时刻）：不重复", () => assert.equal(R.due(ev({notifiedFor: at("2026-10-23", "14:15")}), "event", at("2026-10-23", "14:20"), 0), null));
test("提醒过之后改了时间：重新提醒", () => {
  const moved = ev({time:"16:00", notifiedFor: at("2026-10-23", "14:15")});
  assert.ok(R.due(moved, "event", at("2026-10-23", "15:45"), 0));
});
test("点了“10 分钟后”：在 snoozeAt 那一刻再提醒一次", () => {
  const s = at("2026-10-23", "14:25");
  const x = ev({notifiedFor: at("2026-10-23", "14:15"), snoozeAt: s});
  assert.equal(R.due(x, "event", at("2026-10-23", "14:24"), 0), null);
  assert.ok(R.due(x, "event", at("2026-10-23", "14:25"), 0));
});
test("定时推送宁可早到：提前 15 分钟以内就发（#5）", () => {
  const lead = ctx.App.core.C.PUSH_LEAD_MS;
  assert.ok(R.due(e1, "event", at("2026-10-23", "14:00"), lead));
  assert.equal(R.due(e1, "event", at("2026-10-23", "13:59"), lead), null);
});
test("dueList 按提醒时刻从早到晚排序，日程和待办混排", () => {
  const now = at("2026-10-23", "14:20");
  // 待办 9:00 的提醒被推迟到 14:10；14:25 准时的日程还没到；不提醒的日程不出现
  const snoozed = td({due:"2026-10-23", notifiedFor: at("2026-10-23", "09:00"), snoozeAt: at("2026-10-23", "14:10")});
  const list = R.dueList([ev({}), ev({time:"14:25", remindMin:0}), ev({remindMin:null})], [snoozed], now, 0);
  assert.deepEqual(plain(list.map(x => [x.kind, x.at])), [["todo", at("2026-10-23", "14:10")], ["event", at("2026-10-23", "14:15")]]);
});

// —— 选项与标签 ——
test("有时间的日程：6 个选项", () => assert.deepEqual(plain(R.options("event", true).map(o => o.label)), ["不提醒", "准时", "15 分", "30 分", "1 小时", "1 天"]));
test("全天日程：3 个选项", () => assert.deepEqual(plain(R.options("event", false).map(o => o.label)), ["不提醒", "当天 9:00", "前一天 20:00"]));
test("待办：3 个选项", () => assert.deepEqual(plain(R.options("todo").map(o => o.label)), ["不提醒", "当天 9:00", "前一天 9:00"]));
test("铃铛标签", () => {
  assert.equal(R.label(ev({}), "event"), "提前 15 分");
  assert.equal(R.label(ev({remindMin:0}), "event"), "准时提醒");
  assert.equal(R.label(ev({remindMin:60}), "event"), "提前 1 小时");
  assert.equal(R.label(allday({}), "event"), "前一天 20:00");
  assert.equal(R.label(td({important:true}), "todo"), "前一天 9:00");
  assert.equal(R.label(td({remindDays:null}), "todo"), "");
});
test("当前选中值：缺字段时是默认值", () => {
  assert.equal(R.currentValue(ev({}), "event"), 15);
  assert.equal(R.currentValue(td({important:true}), "todo"), 1);
  assert.equal(R.currentValue(td({remindDays:null}), "todo"), null);
});

await done("提醒规则单元测试（今天 2026-10-23 周五）");
