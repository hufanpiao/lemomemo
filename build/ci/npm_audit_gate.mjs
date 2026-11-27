// npm audit 高危关口，和 OSV-Scanner 共用一份豁免清单 osv-scanner.toml（unit.yml 依赖审计一步调用）。
// 背景（11-18）：picomatch 出了 GHSA-fc5q-39xc-vjpf（ReDoS），受影响范围写到最新版 4.0.7，没有修复版可升，
//   overrides 也没法用；npm audit 本身没有按编号忽略的开关，原来的 `npm audit --audit-level=high` 只能整步失败、挡住部署。
// 做法：跑 `npm audit --json`，把高危、严重的通告按 GHSA 编号列出来；每个编号都要在 osv-scanner.toml 里有一条
//   [[IgnoredVulns]]，且 ignoreUntil 没过期，才放行。清单里写原因、复查日期、会签，规则见那个文件的文件头。
//   不认识的形状（没有 url、读不出编号）一律判失败，不静默放行；npm audit 自己出错（不是“有漏洞”的退出码）也判失败。
// 只读：不写文件、不装依赖；只读 package-lock.json（npm audit 的默认行为）。
//
// 用法：node build/ci/npm_audit_gate.mjs [--prefix <目录>]
// 退出码：0 没有未豁免的高危；1 有未豁免的高危，或查不了。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LEVELS = new Set(['high', 'critical']);

/** 从 osv-scanner.toml 读出 { 编号: 'YYYY-MM-DD' }（只认本仓库用到的 id / ignoreUntil 两个键）。 */
export function ignoresOf(toml) {
  const out = new Map();
  for (const block of toml.split('[[IgnoredVulns]]').slice(1)) {
    const id = /^\s*id\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const until = /^\s*ignoreUntil\s*=\s*(\d{4}-\d{2}-\d{2})/m.exec(block)?.[1];
    if (id && until) out.set(id, until);
  }
  return out;
}

/** 从 npm audit --json 里取出高危、严重通告：[{ id, pkg, title }]；读不出编号的记 id=null。 */
export function highOf(report) {
  const seen = new Map();
  for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== 'object' || !LEVELS.has(via.severity)) continue;
      const id = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/.exec(via.url ?? '')?.[0] ?? null;
      const key = id ?? `${pkg}:${via.title}`;
      if (!seen.has(key)) seen.set(key, { id, pkg, title: via.title ?? '' });
    }
  }
  return [...seen.values()];
}

/** 判定：返回没被豁免的条目（空数组就是放行）。today 为 'YYYY-MM-DD'。 */
export function blocked(found, ignores, today) {
  return found.filter((f) => !(f.id && ignores.has(f.id) && ignores.get(f.id) >= today));
}

function runAudit(prefix) {
  const args = ['audit', '--json', ...(prefix ? ['--prefix', prefix] : [])];
  try {
    return execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 << 20 });
  } catch (e) {
    // 有漏洞时 npm audit 退出码 1，但 stdout 里照样是完整 JSON；读不出 JSON 才算出错
    if (typeof e.stdout === 'string' && e.stdout.trim().startsWith('{')) return e.stdout;
    throw e;
  }
}

function main() {
  const i = process.argv.indexOf('--prefix');
  const prefix = i > 0 ? process.argv[i + 1] : '';
  const report = JSON.parse(runAudit(prefix));
  if (report.error) throw new Error(`npm audit 出错：${JSON.stringify(report.error)}`);
  const ignores = ignoresOf(readFileSync(resolve(ROOT, 'osv-scanner.toml'), 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  const found = highOf(report);
  const bad = blocked(found, ignores, today);
  const where = prefix || '.';
  for (const f of found) {
    const ok = !bad.includes(f);
    console.log(`${ok ? '已豁免' : '未豁免'}  ${f.id ?? '（无编号）'}  ${f.pkg}  ${f.title}${ok ? `（到 ${ignores.get(f.id)}）` : ''}`);
  }
  if (bad.length) {
    console.error(`npm audit（${where}）：${bad.length} 条高危没有豁免或豁免已过期；确认不受影响的写进 osv-scanner.toml 并会签`);
    process.exit(1);
  }
  console.log(`npm audit（${where}）：高危 ${found.length} 条，全部在 osv-scanner.toml 里豁免且未过期`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`npm audit 关口查不了：${e?.message ?? e}`);
    process.exit(1);
  }
}
