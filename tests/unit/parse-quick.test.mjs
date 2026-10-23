// 单元测试：一句话解析 parseQuick。“今天”固定为 2026-10-23（周五），项目名单为三个已知项目。
// 1）固定用例：预期值取自 v2 线上版本的实际输出；2）对照测试：从冻结的 archive/releases/v2/planner.html
//    抽出原版 parseQuick，与重构后的版本逐条比对。依赖：Node 18+ 内置 node:vm、node:fs、node:assert。
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TODAY = "2026-10-23";
const PROJECTS = ["SignPlex", "NEOX", "SOIL STUDIO"];

// —— 按构建时的方式加载源码：每个文件包一层函数作用域，共用一个 App ——
const ctx = vm.createContext({ App: {} });
for (const f of ["core/date.js", "logic/projects.js", "logic/parse-quick.js"]) {
  const src = fs.readFileSync(path.join(ROOT, "src/scripts", f), "utf8");
  vm.runInContext("(function(){\n" + src + "\n})();", ctx, { filename: f });
}
const parseQuick = s => JSON.parse(JSON.stringify(ctx.App.logic.parseQuick(s, TODAY, PROJECTS)));
assert.deepEqual(JSON.parse(JSON.stringify(ctx.App.logic.projects.projectList([], []))), PROJECTS, "已知项目名单应与测试假设一致");

// —— 从冻结的 v2 抽出原版 parseQuick，并把“现在”固定到 TODAY 中午 ——
function loadV2() {
  const html = fs.readFileSync(path.join(ROOT, "archive/releases/v2/planner.html"), "utf8");
  const cut = (from, to) => {
    const a = html.indexOf(from), b = html.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error("在 v2 里找不到代码段：" + from);
    return html.slice(a, b);
  };
  const helpers = cut("const WK = [", "const ICON_CHECK");
  const monday = cut("function mondayOf(s)", "\n");
  const pq = cut("function parseQuick(s){", "// —— 弹出层");
  const code = `(function(Date){ ${helpers}\n${monday}\nconst projects = () => ${JSON.stringify(PROJECTS)};\n${pq}\nreturn parseQuick; })`;
  const [y, m, d] = TODAY.split("-").map(Number);
  const FIXED = new Date(y, m - 1, d, 12, 0, 0).getTime();
  class FixedDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(FIXED); }
    static now() { return FIXED; }
  }
  const fn = vm.runInNewContext(code, {}, { filename: "v2-parseQuick" })(FixedDate);
  return s => JSON.parse(JSON.stringify(fn(s)));
}
const parseQuickV2 = loadV2();

// —— 固定用例（预期 = v2 当前输出）——
const CASES = [
  ["下周三下午两点半和 NEOX 对片", { title: "和 NEOX 对片", date: "2026-10-28", time: "14:30", important: false, project: "NEOX", kind: "event" }],
  ["明天上午10点 SignPlex 客户会", { title: "SignPlex 客户会", date: "2026-10-24", time: "10:00", important: false, project: "SignPlex", kind: "event" }],
  ["周五前交 SOIL STUDIO 横版 重要", { title: "交 SOIL STUDIO 横版", date: "2026-10-23", time: "", important: true, project: "SOIL STUDIO", kind: "todo" }],
  ["10月30号 体检", { title: "体检", date: "2026-10-30", time: "", important: false, project: "", kind: "todo" }],
  ["今晚8:30 看粗剪", { title: "看粗剪", date: "2026-10-23", time: "20:30", important: false, project: "", kind: "event" }],
  ["买硬盘", { title: "买硬盘", date: "", time: "", important: false, project: "", kind: "todo" }],
  ["十一月三号下午三点 报价", { title: "报价", date: "2026-11-03", time: "15:00", important: false, project: "", kind: "event" }],
];

// 对照测试额外覆盖的说法（不写死预期，只要求与 v2 完全一致）
const EXTRA = [
  "后天 交 NEOX 竖版", "大后天下午4点一刻 开会", "明早9点 跑步", "这周日 大扫除", "下下周一 交报告",
  "星期3 中午12点 吃饭", "礼拜天 休息", "2027年1月5日 续签合同", "12/25 圣诞", "15号 交房租",
  "3号 体检", "凌晨2点 渲染", "傍晚6点半 散步", "晚上11点三刻 睡觉", "提醒我 明天 打电话 !!",
  "记得 买牛奶 紧急", "signplex 改字幕", "soil studio 选植物", "明天", "下午", "  ", "今天下午两点 25分",
  "10点 和 neox 开会", "周五", "1月1日", "十号 交稿", "明天 25点 看片",
];

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log("  通过  " + name); }
  catch (e) { fail++; console.log("  失败  " + name + "\n        " + e.message.split("\n").join("\n        ")); }
}

console.log(`parseQuick 单元测试（今天固定为 ${TODAY} 周五）`);
for (const [input, want] of CASES) {
  check("固定用例：" + input, () => assert.deepEqual(parseQuick(input), want));
  check("与 v2 一致：" + input, () => assert.deepEqual(parseQuick(input), parseQuickV2(input)));
}
for (const input of EXTRA) {
  check("与 v2 一致：" + JSON.stringify(input), () => assert.deepEqual(parseQuick(input), parseQuickV2(input)));
}
console.log(`\n共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
