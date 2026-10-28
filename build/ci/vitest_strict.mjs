#!/usr/bin/env node
// CI 里“必须真跑”的 Vitest（B0 代码审查中 2、QA D-04）：环境变量不在就跳过的测试，在 CI 里不许悄悄跳过。
//
// 用法（仓库根目录）：
//   node build/ci/vitest_strict.mjs --must "<用例名片段>" [--must …] [--allow-todo "<用例名片段>" …] -- <测试文件…>
//
// 跑一遍 Vitest（默认输出照常打印），再读它的 JSON 结果，下面任何一条就失败：
//   ① 有用例失败（Vitest 自己的退出码）；
//   ② 有用例是 skipped / pending / todo（缺环境时 skipIf、it.skip 都算）；
//   ③ 有“通过”的用例名以“跳过”开头（tests/shared/objstore.test.ts 这类没环境时用一条占位用例代替整组的写法，QA D-10）；
//   ④ 每个 --must 片段都要对上至少一条“通过”的用例（全名包含它）：证明打真替身的那一组确实跑了，而不是整组没收集到；
//   ⑤ 一条用例都没跑。
// --allow-todo：只放行名字包含该片段的 it.todo（已定挪到后面批次的用例，如 TC-B0-116、117，架构 0.33 第 1 条）；
//   skipped 照样失败；每个 --allow-todo 片段都必须对上至少一条 todo，用例落地后不删这个参数也会失败。
// 只读结果、不改任何文件；JSON 写在系统临时目录（CI 是 RUNNER_TEMP），跑完删掉。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

let cleanup = () => {};
function fail(msg) {
  console.error(`::error::${msg}`);
  cleanup(); // process.exit 不会走 finally，临时目录在这里删
  process.exit(1);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0) fail('用法：node build/ci/vitest_strict.mjs --must "<用例名片段>" … -- <测试文件…>');
const must = [];
const allowTodo = [];
const head = argv.slice(0, sep);
for (let i = 0; i < head.length; i++) {
  if (head[i] === '--must' && head[i + 1]) must.push(head[++i]);
  else if (head[i] === '--allow-todo' && head[i + 1]) allowTodo.push(head[++i]);
  else fail(`看不懂的参数：${head[i]}`);
}
const files = argv.slice(sep + 1);
if (!files.length) fail('至少给一个测试文件');

const vitest = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const dir = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), 'vitest-strict-'));
const out = path.join(dir, 'result.json');
cleanup = () => rmSync(dir, { recursive: true, force: true });

try {
  const r = spawnSync(
    process.execPath,
    [vitest, 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`, ...files],
    { stdio: 'inherit' },
  );
  if (r.error) fail(`Vitest 没起来：${r.error.message}`);

  let result;
  try {
    result = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    fail('读不到 Vitest 的 JSON 结果');
  }
  const cases = (result.testResults ?? []).flatMap((f) =>
    (f.assertionResults ?? []).map((a) => ({ file: path.relative(process.cwd(), f.name), name: a.fullName ?? a.title, title: a.title, status: a.status })),
  );

  const problems = [];
  if (r.status !== 0) problems.push(`Vitest 退出码 ${r.status}（有用例失败或收集出错）`);
  if (!cases.length) problems.push('一条用例都没跑');
  for (const c of cases) {
    if (c.status === 'todo' && allowTodo.some((t) => c.name.includes(t))) continue;
    if (c.status !== 'passed' && c.status !== 'failed') problems.push(`没真跑（${c.status}）：${c.file} › ${c.name}`);
    else if (c.status === 'passed' && /^跳过/.test(c.title)) problems.push(`占位用例代替了整组（缺环境）：${c.file} › ${c.name}`);
  }
  for (const m of must) {
    if (!cases.some((c) => c.status === 'passed' && c.name.includes(m))) problems.push(`要求必须通过的用例没通过或没跑：“${m}”`);
  }

  for (const t of allowTodo) {
    if (!cases.some((c) => c.status === 'todo' && c.name.includes(t))) problems.push(`--allow-todo “${t}”没有对上任何 todo（用例已落地就删掉这个参数）`);
  }

  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    fail(`严格模式不通过（${problems.length} 项）：CI 里这些测试必须对着真环境跑，缺环境就失败`);
  }
  console.log(`严格模式通过：${cases.length} 条全部真跑并通过；必须项 ${must.length} 个都对上`);
} finally {
  cleanup();
}
