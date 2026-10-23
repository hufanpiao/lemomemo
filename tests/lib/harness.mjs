// 职责：单元测试的公共工具：loadApp() 按构建时的方式（每个文件包一层函数作用域、共用一个 App）把源码加载进 Node 的 vm；
//       test()/done() 是极简的测试登记与汇总；plain() 把 vm 里的对象转成普通对象，便于 deepEqual 比较；fakeClock() 固定“现在”。
// 依赖：Node 18+ 内置 node:vm、node:fs、node:path
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// files：相对项目根的路径；globals：额外放进全局的东西
export function loadApp(files, globals = {}) {
  const ctx = vm.createContext(Object.assign({
    App: {}, console, setTimeout, clearTimeout, setInterval, clearInterval,
  }, globals));
  ctx.globalThis = ctx;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/^\uFEFF/, "");
    vm.runInContext("(function(){\n" + src + "\n})();", ctx, { filename: f });
  }
  return ctx;
}
export const src = name => "src/scripts/" + name;
export const plain = x => JSON.parse(JSON.stringify(x));
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// 固定在本地时间 y-m-d h:mi 的假时钟，可 advance(毫秒) 往前拨
export function fakeClock(ctx, y, m, d, h = 12, mi = 0) {
  let now = new Date(y, m - 1, d, h, mi).getTime();
  const date = ctx.App.core.date;
  return {
    now: () => now, today: () => date.todayOf(now), nowMin: () => date.minOfDay(now), hour: () => date.hourOf(now),
    advance(ms) { now += ms; }, set(ms) { now = ms; },
  };
}

const cases = [];
export function test(name, fn) { cases.push([name, fn]); }
export async function done(title) {
  let pass = 0, fail = 0;
  console.log(title);
  for (const [name, fn] of cases) {
    try { await fn(); pass++; console.log("  通过  " + name); }
    catch (e) { fail++; console.log("  失败  " + name + "\n        " + String(e && e.message || e).split("\n").join("\n        ")); }
  }
  console.log(`  —— 共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}\n`);
  process.exitCode = fail ? 1 : (process.exitCode || 0);
  return { pass, fail };
}
