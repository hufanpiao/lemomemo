// 职责：一次跑完全部测试：tests/unit/ 下每个 *.test.mjs（各自单独进程），再跑架构检查自检
//       （python build/check_arch.py --self-test）。任何一项失败，退出码为 1。用法：node tests/run-all.mjs
// 依赖：Node 18+、Python 3（命令名 python；可用环境变量 PYTHON 指定）
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./lib/harness.mjs";

const unit = path.join(ROOT, "tests/unit");
let failed = 0, pass = 0, fail = 0;
for (const f of fs.readdirSync(unit).filter(f => f.endsWith(".test.mjs")).sort()) {
  const r = spawnSync(process.execPath, [path.join(unit, f)], { encoding: "utf8" });
  process.stdout.write(r.stdout + (r.stderr || ""));
  const m = r.stdout.match(/通过 (\d+)，失败 (\d+)/);
  if (m) { pass += Number(m[1]); fail += Number(m[2]); }
  if (r.status !== 0) failed++;
}
const py = spawnSync(process.env.PYTHON || "python", [path.join(ROOT, "build/check_arch.py"), "--self-test"],
  { encoding: "utf8", env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" }) });
process.stdout.write("架构检查自检\n" + (py.stdout || "") + (py.stderr || "") + "\n");
if (py.status !== 0) failed++;
console.log(`单元测试合计：通过 ${pass}，失败 ${fail}；架构自检：${py.status === 0 ? "通过" : "失败"}`);
process.exitCode = failed ? 1 : 0;
