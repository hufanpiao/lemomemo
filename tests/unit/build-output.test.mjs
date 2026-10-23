// 职责：构建产物检查：发布用的 dist/planner.html 不能带任何环境提示条文案；两个本地测试页必须带“测试页面”提示条；
//       预发布版 dist/staging.html（若已用 --target staging 生成）必须带“预发布测试版”提示，且同样接真实数据库（claude-db）。
//       先跑 python build/build.py（以及 --target staging）再跑本测试。
// 依赖：tests/lib/harness.mjs、dist/ 下的构建产物
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { ROOT, test, done } from "../lib/harness.mjs";

const TEST_TEXT = "测试页面：这里用的是模拟数据，刷新就会还原，不会保存到云端";
const STAGING_TEXT = "预发布测试版：不是你的正式数据";
const read = f => fs.readFileSync(path.join(ROOT, "dist", f), "utf8");
const has = f => fs.existsSync(path.join(ROOT, "dist", f));

test("dist/planner.html 不含任何环境提示文案", () => {
  const html = read("planner.html");
  assert.ok(!html.includes(TEST_TEXT), "发布版里出现了测试提示");
  assert.ok(!html.includes(STAGING_TEXT), "发布版里出现了预发布提示");
  assert.ok(!html.includes("pv-env-banner"), "发布版里出现了提示条元素");
});
for (const f of ["test.html", "test-claude.html"]) {
  test(`dist/${f} 顶部有测试提示条，且不挡操作`, () => {
    const html = read(f);
    assert.ok(html.includes(TEST_TEXT));
    assert.match(html, /class="pv-env-banner"[^>]*pointer-events:none/);
  });
}
if (has("staging.html")) test("dist/staging.html 带预发布提示、接真实数据库", () => {
  const html = read("staging.html");
  assert.ok(html.includes(STAGING_TEXT));
  assert.ok(!html.includes(TEST_TEXT));
  assert.match(html, /App\.BUILD = \{"target": "staging", "storage": "claude-db"\}/);
});

await done("构建产物检查");
