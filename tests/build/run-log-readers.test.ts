// 运行日志 11-20 起分段存（src/platform/run-log-store.ts：lemo-run-log.c<序号>，旧的整份键 lemo-run-log 不再写）：
// 谁也不许再直接读写旧键——读到的是空的，用例会悄悄失效。src 里只有 run-log-store.ts 认旧键（升级时迁移）；
// e2e 在页面里读一律走 tests/e2e/page-helpers.ts 的 readRunLogInPage。并扫 tests/e2e 和 src 全部 .ts/.tsx
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const OLD = /(getItem|setItem|removeItem)\(\s*['"`]lemo-run-log['"`]\s*\)/;
/** 允许：迁移旧键的存储模块本身 */
const ALLOW = new Set(['src/platform/run-log-store.ts']);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(full);
    return /\.tsx?$/.test(d.name) ? [relative(ROOT, full).split(/[\\/]/).join('/')] : [];
  });
}

describe('运行日志只经 readRunLog / readRunLogInPage 读', () => {
  it('tests/e2e、src 里没有直接读写旧键 lemo-run-log 的', () => {
    const bad = [...walk(join(ROOT, 'tests', 'e2e')), ...walk(join(ROOT, 'src'))].filter((f) => !ALLOW.has(f) && OLD.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(bad, '运行日志分段存了，改用 tests/e2e/page-helpers.ts 的 readRunLogInPage（页面里）或 platform/run-log.ts 的 readRunLog').toEqual([]);
  });

  it('拦得住：一行直接读旧键的写法会被认出来', () => {
    expect(OLD.test("page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '')")).toBe(true);
    expect(OLD.test('localStorage.getItem(`lemo-run-log.c${n}`)')).toBe(false);
  });
});
