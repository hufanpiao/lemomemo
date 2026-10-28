// W3（架构 2.3、2.6；TC-B0-11；QA D-06）：首屏 JS 超预算时 build/check_size.mjs 失败。
// 违规样例 tests/arch-fixtures/check_size/w3-over-budget/manifest.json：一份 Vite manifest（入口 + 一个静态 import 的 chunk + 一个懒加载页面）。
// 首屏 JS 的内容测试时现做（几乎压不动的随机字节，免得往仓库里放几百 KB 的文件），放进临时目录再跑脚本
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUDGET, measure } from '../../build/check_size.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const SAMPLE = join(ROOT, 'tests', 'arch-fixtures', 'check_size', 'w3-over-budget');
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 照样例的 manifest 搭一个构建目录；index.js、vendor.js 各 entryBytes 字节随机内容，懒加载页面另给 lazyBytes */
function appDir(entryBytes: number, lazyBytes = 0): string {
  const d = mkdtempSync(join(tmpdir(), 'lemo-w3-'));
  dirs.push(d);
  // 样例的 manifest 放在样例目录根上（仓库的 .gitignore 忽略 .vite/），这里复制到构建目录该在的位置
  mkdirSync(join(d, '.vite'));
  cpSync(join(SAMPLE, 'manifest.json'), join(d, '.vite', 'manifest.json'));
  mkdirSync(join(d, 'assets'));
  // base64 的随机字节：gzip 后约为原长的 76%，压不下去
  const js = (n: number) => `export const x = "${randomBytes(Math.ceil((n * 3) / 4)).toString('base64')}";\n`;
  writeFileSync(join(d, 'assets', 'index.js'), js(entryBytes));
  writeFileSync(join(d, 'assets', 'vendor.js'), js(entryBytes));
  writeFileSync(join(d, 'assets', 'notes.js'), js(lazyBytes));
  return d;
}

function run(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'build', 'check_size.mjs'), '--app-dir', dir], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

describe('W3：首屏 JS 超预算就失败（build/check_size.mjs）', () => {
  it('违规样例：入口 + 静态 import 的 chunk 合计超过 150 KB（gzip）→ 退出码 1，报 W3', () => {
    const dir = appDir(110 * 1024);
    expect(measure(dir).firstScreenJs).toBeGreaterThan(BUDGET.firstScreenJs);
    const { code, out } = run(dir);
    expect(code).toBe(1);
    expect(out).toContain('W3');
  });

  it('对照：首屏小、懒加载的页面再大也不算首屏 → 通过', () => {
    const dir = appDir(4 * 1024, 300 * 1024);
    const r = measure(dir);
    expect(r.firstFiles).toEqual(['assets/index.js', 'assets/vendor.js']);
    expect(r.firstScreenJs).toBeLessThan(BUDGET.firstScreenJs);
    expect(run(dir).code).toBe(0);
  });
});
