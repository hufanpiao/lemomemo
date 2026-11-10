// W3（架构 2.3、2.6；TC-B0-11；QA D-06）：首屏 JS 超预算时 build/check_size.mjs 失败。
// 违规样例 tests/arch-fixtures/check_size/w3-over-budget/manifest.json：一份 Vite manifest（入口 + 一个静态 import 的 chunk + 一个懒加载页面）。
// 首屏 JS 的内容测试时现做（几乎压不动的随机字节，免得往仓库里放几百 KB 的文件），放进临时目录再跑脚本
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUDGET, measure, NET_GROWTH_MESSAGE, netGrowthCheck, publicValues, stableText } from '../../build/check_size.mjs';

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

function run(dir: string, extra: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'build', 'check_size.mjs'), '--app-dir', dir, ...extra], { encoding: 'utf8', stdio: 'pipe' });
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

describe('B3 首屏净增额度：超过 基线 + 1 KB 就失败（build/check_size.mjs --mode）', () => {
  /** 把基线定在“现在的稳定口径首屏字节 - net”，写进临时文件（稳定口径不分平台，CI 的 linux 和本机 win32 同一个数） */
  function baselineFor(dir: string, net: number): string {
    const now = measure(dir).firstScreenStable;
    const f = join(dir, 'baseline.json');
    writeFileSync(f, JSON.stringify({ limitBytes: 1024, modes: ['preview', 'e2e'], baseline: now - net }));
    return f;
  }

  it('超：净增 1025 B（比额度多 1 B）→ 退出码 1，报“B3 首屏净增额度用完”', () => {
    const dir = appDir(4 * 1024);
    const { code, out } = run(dir, ['--mode', 'preview', '--baseline', baselineFor(dir, 1025)]);
    expect(code).toBe(1);
    expect(out).toContain(NET_GROWTH_MESSAGE);
    expect(out).toContain('净增 1025 B > 1024 B');
  });

  it('不超：净增正好 1024 B → 通过；没有基线的模式只提示、不查', () => {
    const dir = appDir(4 * 1024);
    const f = baselineFor(dir, 1024);
    const ok = run(dir, ['--mode', 'preview', '--baseline', f]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('B3 首屏净增：1024 B / 额度 1024 B');
    const skip = run(dir, ['--mode', 'production', '--baseline', f]);
    expect(skip.code).toBe(0);
    expect(skip.out).toContain('净增关卡跳过');
  });

  it('仓库里的基线文件：额度 1096 B（11-10 负责人定放宽，底栏偏高修复 R-371），管 preview 和 e2e；基线没定时是 null（关卡跳过），定了就是正整数且出处不再是“待定”', () => {
    const data = JSON.parse(readFileSync(join(ROOT, 'build', 'first-screen-baseline.json'), 'utf8'));
    expect(data.limitBytes).toBe(1096); // 11-10 负责人定放宽（底栏偏高修复，R-371）：1024 → 1096，上限 1100
    expect(data.modes).toEqual(['preview', 'e2e']);
    if (data.baseline === null) {
      expect(netGrowthCheck(1, data, 'preview').skip).toContain('基线还没定');
      return;
    }
    expect(Number.isInteger(data.baseline) && data.baseline > 0).toBe(true);
    expect(data._出处).not.toMatch(/^待定/);
    expect(netGrowthCheck(data.baseline + data.limitBytes + 1, data, 'preview').error).toContain(NET_GROWTH_MESSAGE);
    expect(netGrowthCheck(data.baseline + data.limitBytes, data, 'e2e').error).toBeNull();
  });

  it('稳定口径：只差构建时刻、提交号、块文件名哈希的两份产物，计数前换成同一份文字（11-09 两次构建抖 39 B 的来源）', () => {
    const a = 'import{a}from"./main-CgKDszg3.js";const t="2026-11-09T04:33:39.868Z",c=`6f0325b`;import("./plus-D_fBmoei.css");';
    const b = 'import{a}from"./main-mmYWtAnE.js";const t="2026-11-09T05:01:02.003Z",c=`unknown`;import("./plus-Cw_7DNvX.css");';
    expect(stableText(a, ['6f0325b', 'unknown'])).toBe(stableText(b, ['6f0325b', 'unknown']));
    // 普通文字不受影响
    expect(stableText('jsx-runtime.js "abc"', ['unknown'])).toBe('jsx-runtime.js "abc"');
  });
  it('稳定口径：注入的公开变量（JWT、VAPID、Turnstile、地址、版本号）长短不同，量回“不注入”的同一份文字（807a10f deploy-preview +1179 的来源）', () => {
    const page = (url: string, anon: string, vapid: string, ts: string, ver: string) =>
      `const e={env:m(\`preview\`),supabaseUrl:\`${url}\`,anonKey:\`${anon}\`,vapid:"${vapid}",turnstile:'${ts}',version:\`${ver}\`};`;
    const none = page('', '', '', '', '4.0.0');
    const envA = { VITE_PUBLIC_ENV: 'preview', VITE_PUBLIC_SUPABASE_URL: 'https://preview.lemomemo.com/sb', VITE_PUBLIC_ANON_KEY: `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(120)}.sig1`, VITE_PUBLIC_VAPID_KEY: `B${'v'.repeat(86)}`, VITE_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAAxxxxxxxxxxxxxx', LEMO_BUILD_VERSION: '4.0.0-preview.7' };
    const envB = { VITE_PUBLIC_ENV: 'preview', VITE_PUBLIC_SUPABASE_URL: 'https://lemomemo-preview-long.lemomemo.com/sb', VITE_PUBLIC_ANON_KEY: `eyJhbGciOiJIUzI1NiJ9.${'b'.repeat(190)}.sig22`, VITE_PUBLIC_VAPID_KEY: `B${'w'.repeat(86)}`, VITE_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAAyyyyyyyyyyyyyyyyyyyyyyyy', LEMO_BUILD_VERSION: '4.0.0-preview.1234' };
    const built = (e: typeof envA) => page(e.VITE_PUBLIC_SUPABASE_URL, e.VITE_PUBLIC_ANON_KEY, e.VITE_PUBLIC_VAPID_KEY, e.VITE_PUBLIC_TURNSTILE_SITE_KEY, e.LEMO_BUILD_VERSION);
    const a = stableText(built(envA), [], publicValues(envA, ROOT));
    const b = stableText(built(envB), [], publicValues(envB, ROOT));
    expect(a).toBe(none);
    expect(b).toBe(none);
    // ENV 和 8 个字符以下的短值不换（怕误伤别处同样的字面量）；没注入时什么都不换
    expect(publicValues({ VITE_PUBLIC_ENV: 'preview', VITE_PUBLIC_ANON_KEY: 'x' }, ROOT)).toEqual([]);
    expect(publicValues({}, ROOT)).toEqual([]);
  });
});
