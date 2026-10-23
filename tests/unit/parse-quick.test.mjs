// 职责：一句话解析 parseQuick 的单元测试。用例直接读 docs/06-测试/测试用例-v3.md 第 4 节的解析表（PQ-ZH / PQ-KO / PQ-MIX / PQ-VO），
//       “今天”2026-10-23（周五），项目名单 SignPlex、NEOX、SOIL STUDIO；测试用例改了，这里自动跟着变。
//       与测试用例不一致、按主持人或需求澄清改过的行写在 OVERRIDES 里（报告里列出）；另有表外的补充用例 EXTRA。
// 依赖：tests/lib/harness.mjs、src/scripts/core/date.js、logic/projects.js、logic/parse-*.js、docs/06-测试/测试用例-v3.md
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { ROOT, loadApp, src, plain, test, done } from "../lib/harness.mjs";

const TODAY = "2026-10-23";
const PROJECTS = ["SignPlex", "NEOX", "SOIL STUDIO"];
const ctx = loadApp([src("core/date.js"), src("logic/projects.js"), src("logic/parse-text.js"), src("logic/parse-date-zh.js"),
  src("logic/parse-date-ko.js"), src("logic/parse-time.js"), src("logic/parse-marks.js"), src("logic/parse-quick.js")]);
const parseQuick = (s, names = PROJECTS) => plain(ctx.App.logic.parseQuick(s, TODAY, names));

// —— 读表 ——
// 列：编号 | 输入 | 今天 | kind | title | date | time | project | important | 提醒 | 优先级 | 备注
const unq = v => (v === '""' ? "" : v);
// 提醒列 → remind：带 * 的是默认值（解析器没识别到）→ null；“-”→ null；min=null / days=null → {off:true}
function remindOf(cell){
  if (cell === "-" || cell.endsWith("*")) return null;
  const [k, v] = cell.split("=");
  if (v === "null") return { off: true };
  return k === "min" ? { min: Number(v) } : { days: Number(v) };
}
function readTable(){
  const md = fs.readFileSync(path.join(ROOT, "docs/06-测试/测试用例-v3.md"), "utf8");
  const sec = md.slice(md.indexOf("## 4. 一句话解析用例表"), md.indexOf("## 5. "));
  const rows = [];
  for (const line of sec.split("\n")) {
    if (!/^\| PQ-/.test(line)) continue;
    const c = line.split("|").slice(1, -1).map(x => x.trim());
    rows.push({ id: c[0].split("（")[0], input: c[1], today: c[2], prio: c[10], note: c[11],
      want: { title: unq(c[4]), date: unq(c[5]), time: unq(c[6]), important: c[8] === "true", project: unq(c[7]), kind: c[3], remind: remindOf(c[9]) } });
  }
  return rows;
}

// 与测试用例不一致的地方（以主持人 T4 指示 / 需求澄清为准），值是要改写的字段
const OVERRIDES = {
  // 主持人 T4：“无效的‘25点’不要从标题里删掉”；测试用例写的是“看片”
  "PQ-ZH-40": { title: "25点 看片" },
};

const ROWS = readTable();
test("解析表读出了全部用例（四组都有）", () => {
  for (const g of ["PQ-ZH", "PQ-KO", "PQ-MIX", "PQ-VO"]) assert.ok(ROWS.some(r => r.id.startsWith(g)), g);
  assert.ok(ROWS.length >= 130, "只读到 " + ROWS.length + " 行");
  for (const r of ROWS) assert.equal(r.today, TODAY, r.id + " 的“今天”不是 " + TODAY);
});
for (const r of ROWS) {
  const want = Object.assign({}, r.want, OVERRIDES[r.id] || {});
  test(`${r.id}（${r.prio}）${r.input}`, () => assert.deepEqual(parseQuick(r.input), want));
}

// —— 表外补充：主持人 T4 点名的说法和边界 ——
const EXTRA = [
  ["提前15分钟提醒 明天下午3点开会", { title: "开会", date: "2026-10-24", time: "15:00", important: false, project: "", kind: "event", remind: { min: 15 } }],
  ["明天下午3点开会 提前十五分钟提醒", { title: "开会", date: "2026-10-24", time: "15:00", important: false, project: "", kind: "event", remind: { min: 15 } }],
  ["下周一交报告 提前一天提醒", { title: "交报告", date: "2026-10-26", time: "", important: false, project: "", kind: "todo", remind: { days: 1 } }],
  ["내일 오후 3시 회의 하루 전 알림", { title: "회의", date: "2026-10-24", time: "15:00", important: false, project: "", kind: "event", remind: { min: 1440 } }],
  ["금요일까지 보고서 하루 전 알림", { title: "보고서", date: "2026-10-23", time: "", important: false, project: "", kind: "todo", remind: { days: 1 } }],
  ["下午3点前交稿", { title: "交稿 15:00前", date: "2026-10-23", time: "", important: false, project: "", kind: "todo", remind: null }],
  ["明天6点前交稿", { title: "交稿 18:00前", date: "2026-10-24", time: "", important: false, project: "", kind: "todo", remind: null }],
  ["明晚12点 上线", { title: "上线", date: "2026-10-25", time: "00:00", important: false, project: "", kind: "event", remind: null }],
  ["下个月三号 体检", { title: "体检", date: "2026-11-03", time: "", important: false, project: "", kind: "todo", remind: null }],
  ["3号线换乘", { title: "3号线换乘", date: "", time: "", important: false, project: "", kind: "todo", remind: null }],
  ["重要的会议 明天", { title: "会议", date: "2026-10-24", time: "", important: true, project: "", kind: "todo", remind: null }],
  ["星期3 中午12点 吃饭", { title: "吃饭", date: "2026-10-28", time: "12:00", important: false, project: "", kind: "event", remind: null }],
  ["礼拜天 休息", { title: "休息", date: "2026-10-25", time: "", important: false, project: "", kind: "todo", remind: null }],
  ["밤 2시 렌더링", { title: "렌더링", date: "2026-10-24", time: "02:00", important: false, project: "", kind: "event", remind: null }],
  ["3시간 회의", { title: "3시간 회의", date: "", time: "", important: false, project: "", kind: "todo", remind: null }],
  ["세 시간 촬영", { title: "세 시간 촬영", date: "", time: "", important: false, project: "", kind: "todo", remind: null }],
  ["5号院", { title: "5号院", date: "", time: "", important: false, project: "", kind: "todo", remind: null }],
  ["오후 세 시 반", { title: "오후 세 시 반", date: "2026-10-23", time: "15:30", important: false, project: "", kind: "event", remind: null }],
  ["！！！", { title: "！！！", date: "", time: "", important: false, project: "", kind: "todo", remind: null }],
];
for (const [input, want] of EXTRA) test("补充：" + input, () => assert.deepEqual(parseQuick(input), want));
test("补充：英文项目名按词边界匹配，“UI”不会命中“GUI”", () => {
  assert.equal(parseQuick("GUI 改版", ["UI"]).project, "");
  assert.equal(parseQuick("改 UI 稿", ["UI"]).project, "UI");
  assert.equal(parseQuick("改UI稿", ["UI"]).project, "UI");          // 紧挨中文可以
  assert.equal(parseQuick("UI2 方案", ["UI"]).project, "");          // 紧挨数字不行
});
test("补充：传入的项目名单不会被修改", () => {
  const names = ["NEOX", "SOIL STUDIO"];
  ctx.App.logic.parseQuick("NEOX", TODAY, names);
  assert.deepEqual(names, ["NEOX", "SOIL STUDIO"]);
});
test("补充：空输入和只有空格不抛错", () => {
  assert.equal(parseQuick("").title, "");
  assert.equal(parseQuick("   ").kind, "todo");
});

await done(`parseQuick 单元测试（今天 ${TODAY} 周五；解析表 ${ROWS.length} 行 + 补充 ${EXTRA.length + 3} 项）`);
