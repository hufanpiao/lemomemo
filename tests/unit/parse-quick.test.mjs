// 职责：一句话解析 parseQuick 的单元测试。“今天”固定为 2026-10-23（周五），项目名单为三个已知项目。
//       预期值直接写死在下面（最初取自 v2 线上版本的输出）；v3 改解析规则时，改对应行的预期值即可。
//       另测拆分出来的几个步骤函数。
// 依赖：tests/lib/harness.mjs、src/scripts/core/date.js、src/scripts/logic/parse-quick.js
import assert from "node:assert/strict";
import { loadApp, src, plain, test, done } from "../lib/harness.mjs";

const TODAY = "2026-10-23";
const PROJECTS = ["SignPlex", "NEOX", "SOIL STUDIO"];
const ctx = loadApp([src("core/date.js"), src("logic/projects.js"), src("logic/parse-quick.js")]);
const parseQuick = s => plain(ctx.App.logic.parseQuick(s, TODAY, PROJECTS));
const steps = ctx.App.logic.parseQuickSteps;

// 必测的 7 句
const REQUIRED = [
  ["下周三下午两点半和 NEOX 对片", {title:"和 NEOX 对片", date:"2026-10-28", time:"14:30", important:false, project:"NEOX", kind:"event"}],
  ["明天上午10点 SignPlex 客户会", {title:"SignPlex 客户会", date:"2026-10-24", time:"10:00", important:false, project:"SignPlex", kind:"event"}],
  ["周五前交 SOIL STUDIO 横版 重要", {title:"交 SOIL STUDIO 横版", date:"2026-10-23", time:"", important:true, project:"SOIL STUDIO", kind:"todo"}],
  ["10月30号 体检", {title:"体检", date:"2026-10-30", time:"", important:false, project:"", kind:"todo"}],
  ["今晚8:30 看粗剪", {title:"看粗剪", date:"2026-10-23", time:"20:30", important:false, project:"", kind:"event"}],
  ["买硬盘", {title:"买硬盘", date:"", time:"", important:false, project:"", kind:"todo"}],
  ["十一月三号下午三点 报价", {title:"报价", date:"2026-11-03", time:"15:00", important:false, project:"", kind:"event"}],
];
// 其他说法
const MORE = [
  ["后天 交 NEOX 竖版", {title:"交 NEOX 竖版", date:"2026-10-25", time:"", important:false, project:"NEOX", kind:"todo"}],
  ["大后天下午4点一刻 开会", {title:"开会", date:"2026-10-26", time:"16:15", important:false, project:"", kind:"event"}],
  ["明早9点 跑步", {title:"跑步", date:"2026-10-24", time:"09:00", important:false, project:"", kind:"event"}],
  ["这周日 大扫除", {title:"大扫除", date:"2026-10-25", time:"", important:false, project:"", kind:"todo"}],
  ["下下周一 交报告", {title:"交报告", date:"2026-11-02", time:"", important:false, project:"", kind:"todo"}],
  ["星期3 中午12点 吃饭", {title:"吃饭", date:"2026-10-28", time:"12:00", important:false, project:"", kind:"event"}],
  ["礼拜天 休息", {title:"休息", date:"2026-10-25", time:"", important:false, project:"", kind:"todo"}],
  ["2027年1月5日 续签合同", {title:"续签合同", date:"2027-01-05", time:"", important:false, project:"", kind:"todo"}],
  ["12/25 圣诞", {title:"圣诞", date:"2026-12-25", time:"", important:false, project:"", kind:"todo"}],
  ["15号 交房租", {title:"交房租", date:"2026-11-15", time:"", important:false, project:"", kind:"todo"}],
  ["3号 体检", {title:"体检", date:"2026-11-03", time:"", important:false, project:"", kind:"todo"}],
  ["凌晨2点 渲染", {title:"渲染", date:"2026-10-23", time:"02:00", important:false, project:"", kind:"event"}],
  ["傍晚6点半 散步", {title:"散步", date:"2026-10-23", time:"18:30", important:false, project:"", kind:"event"}],
  ["晚上11点三刻 睡觉", {title:"睡觉", date:"2026-10-23", time:"23:45", important:false, project:"", kind:"event"}],
  ["提醒我 明天 打电话 !!", {title:"打电话", date:"2026-10-24", time:"", important:true, project:"", kind:"todo"}],
  ["记得 买牛奶 紧急", {title:"买牛奶", date:"", time:"", important:true, project:"", kind:"todo"}],
  ["signplex 改字幕", {title:"signplex 改字幕", date:"", time:"", important:false, project:"SignPlex", kind:"todo"}],
  ["soil studio 选植物", {title:"soil studio 选植物", date:"", time:"", important:false, project:"SOIL STUDIO", kind:"todo"}],
  ["明天", {title:"明天", date:"2026-10-24", time:"", important:false, project:"", kind:"todo"}],
  ["下午", {title:"下午", date:"", time:"", important:false, project:"", kind:"todo"}],
  ["  ", {title:"", date:"", time:"", important:false, project:"", kind:"todo"}],
  ["今天下午两点 25分", {title:"25分", date:"2026-10-23", time:"14:00", important:false, project:"", kind:"event"}],
  ["10点 和 neox 开会", {title:"和 neox 开会", date:"2026-10-23", time:"10:00", important:false, project:"NEOX", kind:"event"}],
  ["周五", {title:"周五", date:"2026-10-23", time:"", important:false, project:"", kind:"todo"}],
  ["1月1日", {title:"1月1日", date:"2027-01-01", time:"", important:false, project:"", kind:"todo"}],
  ["十号 交稿", {title:"交稿", date:"2026-11-10", time:"", important:false, project:"", kind:"todo"}],
  ["明天 25点 看片", {title:"看片", date:"2026-10-24", time:"", important:false, project:"", kind:"todo"}],
];

test("已知项目名单与测试假设一致", () => assert.deepEqual(plain(ctx.App.logic.projects.projectList([], [])), PROJECTS));
for (const [input, want] of REQUIRED) test("必测：" + input, () => assert.deepEqual(parseQuick(input), want));
for (const [input, want] of MORE) test("其他：" + JSON.stringify(input), () => assert.deepEqual(parseQuick(input), want));
test("步骤：中文数字只转紧跟点/月/日/号/分的", () => assert.equal(steps.digitize("周三下午两点半 十一月三号"), "周三下午2点半 11月3号"));
test("步骤：项目匹配长名字优先、不分大小写", () => {
  assert.equal(steps.findProject(" soil studio 和 SOIL ", ["SOIL", "SOIL STUDIO"]), "SOIL STUDIO");
  assert.equal(steps.findProject(" 买菜 ", PROJECTS), "");
});
test("步骤：标题去掉开头的“记得/提醒我”和首尾标点", () => assert.equal(steps.cleanTitle("  记得 买牛奶， ", "x"), "买牛奶"));
test("传入的项目名单不会被修改", () => { const names = ["NEOX", "SOIL STUDIO"]; ctx.App.logic.parseQuick("NEOX", TODAY, names); assert.deepEqual(names, ["NEOX", "SOIL STUDIO"]); });

await done("parseQuick 单元测试（今天固定为 " + TODAY + " 周五）");
