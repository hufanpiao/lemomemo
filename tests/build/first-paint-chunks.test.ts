// build/check_first_paint_chunks.mjs（FA-6 ③ 审查 M3 第二轮）：按 Vite manifest 算“入口 + 今天页、告知页关口”的静态闭包，里面不许有 zod。
// 用假 manifest 覆盖审查员的变异 R3（今天页引 rows.ts → 闭包里出现 _rows-、_zod-jitless-）、zod 被并进别的块、动态 import 不算；
// 再核对 build_web.mjs 在删掉 .vite 之前跑它、失败时构建退出码非 0，FIRST_PAINT_DYNAMIC 和源码里的懒加载对得上
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFirstPaint, FIRST_PAINT_DYNAMIC, LUNAR_MARKS, MOTION_MARKS, staticClosure, ZOD_MARKS } from '../../build/check_first_paint_chunks.mjs';

type Chunk = { file: string; src?: string; name?: string; isEntry?: boolean; isDynamicEntry?: boolean; imports?: string[]; dynamicImports?: string[] };
type Manifest = Record<string, Chunk>;
const ROOT = join(import.meta.dirname, '..', '..');

/** 一份和现在产物同形的假 manifest：入口、今天页、告知页关口、告知页；rows、zod-jitless 只被动态 import */
function base(): Manifest {
  return {
    'index.html': { file: 'assets/main-a.js', src: 'index.html', isEntry: true, imports: ['_jsx-runtime-a.js'], dynamicImports: ['_rows-a.js', 'features/today/ui/TodayPage.tsx', 'features/onboarding/ui/ConsentGate.tsx'] },
    '_jsx-runtime-a.js': { file: 'assets/jsx-runtime-a.js', name: 'jsx-runtime' },
    'features/today/ui/TodayPage.tsx': { file: 'assets/TodayPage-a.js', src: 'features/today/ui/TodayPage.tsx', isDynamicEntry: true, imports: ['_jsx-runtime-a.js', '_components-a.js'] },
    '_components-a.js': { file: 'assets/components-a.js', name: 'components' },
    'features/onboarding/ui/ConsentGate.tsx': { file: 'assets/ConsentGate-a.js', src: 'features/onboarding/ui/ConsentGate.tsx', isDynamicEntry: true, imports: ['_jsx-runtime-a.js'], dynamicImports: ['features/onboarding/ui/ConsentPage.tsx'] },
    'features/onboarding/ui/ConsentPage.tsx': { file: 'assets/ConsentPage-a.js', src: 'features/onboarding/ui/ConsentPage.tsx', isDynamicEntry: true, imports: ['_jsx-runtime-a.js'] },
    // 今天页里的提醒部件（③ 审查第三轮：MissedReminders 漏登过；11-05 起 MissedReminders 等引擎 armed 才挂、不在首屏，留在名单里只会更严）
    'features/reminders/ui/MissedReminders.tsx': { file: 'assets/MissedReminders-a.js', src: 'features/reminders/ui/MissedReminders.tsx', isDynamicEntry: true, imports: ['_jsx-runtime-a.js'] },
    'features/reminders/ui/UnsyncedRemind.tsx': { file: 'assets/UnsyncedRemind-a.js', src: 'features/reminders/ui/UnsyncedRemind.tsx', isDynamicEntry: true, imports: ['_jsx-runtime-a.js'] },
    'features/reminders/ui/UnsyncedRemindMark.tsx': { file: 'assets/UnsyncedRemindMark-a.js', src: 'features/reminders/ui/UnsyncedRemindMark.tsx', isDynamicEntry: true, imports: ['_jsx-runtime-a.js'] },
    '_rows-a.js': { file: 'assets/rows-a.js', name: 'rows', isDynamicEntry: true, imports: ['_zod-jitless-a.js'] },
    '_zod-jitless-a.js': { file: 'assets/zod-jitless-a.js', name: 'zod-jitless' },
    'style.css': { file: 'assets/style-a.css', src: 'style.css' },
  };
}
const text = (overrides: Record<string, string> = {}) => (f: string): string => overrides[f] ?? `/* ${f} */ export const x = 1;`;

describe('首屏块里不许有 zod（按构建产物，FA-6 ③ M3）', () => {
  it('现在的形状：通过；rows、zod-jitless 只被动态 import，不进闭包', () => {
    const m = base();
    expect(checkFirstPaint(m, text())).toEqual([]);
    const c = staticClosure(m, ['index.html', ...FIRST_PAINT_DYNAMIC]);
    expect(c).not.toContain('_rows-a.js');
    expect(c).not.toContain('_zod-jitless-a.js');
  });

  it('变异 R3：今天页静态引 rows.ts（闭包里出现 _rows-、跟着带进 _zod-jitless-）：拦住', () => {
    const m = base();
    m['features/today/ui/TodayPage.tsx']?.imports?.push('_rows-a.js');
    const bad = checkFirstPaint(m, text());
    expect(bad.some((b: string) => b.includes('_rows-a.js'))).toBe(true);
    expect(bad.some((b: string) => b.includes('_zod-jitless-a.js'))).toBe(true);
  });

  it('变异 R3b：错过提醒那一行（MissedReminders）静态引 rows.ts：拦住（③ 审查第三轮，名单原来漏了它）', () => {
    const m = base();
    m['features/reminders/ui/MissedReminders.tsx']?.imports?.push('_rows-a.js');
    expect(checkFirstPaint(m, text()).some((b: string) => b.includes('_rows-a.js'))).toBe(true);
  });

  it('告知页（关口懒加载的那一层）静态引 shared/schema 的块：拦住', () => {
    const m = base();
    m['_schema-a.js'] = { file: 'assets/x-a.js', name: 'x', src: '../shared/schema/settings.ts' };
    m['features/onboarding/ui/ConsentPage.tsx']?.imports?.push('_schema-a.js');
    expect(checkFirstPaint(m, text())).toHaveLength(1);
  });

  it('zod 被并进了别的块（名字认不出）：按内容的特征字符串拦住', () => {
    for (const mark of ZOD_MARKS) {
      const bad = checkFirstPaint(base(), text({ 'assets/components-a.js': `class ${mark} {}` }));
      expect(bad, mark).toHaveLength(1);
      expect(bad[0]).toContain('components-a.js');
    }
  });

  it('动画库 Motion 被静态引回首屏（R-354）：按内容的特征字符串拦住', () => {
    for (const mark of MOTION_MARKS) {
      const bad = checkFirstPaint(base(), text({ 'assets/components-a.js': `const o={${mark}:1}` }));
      expect(bad, mark).toHaveLength(1);
      expect(bad[0]).toContain('components-a.js');
      expect(bad[0]).toContain('Motion');
    }
  });

  it('manifest 里找不到首屏动态入口（改了路由没同步）：报出来，不当通过', () => {
    const m = base();
    delete m['features/onboarding/ui/ConsentGate.tsx'];
    const bad = checkFirstPaint(m, text());
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain('ConsentGate');
  });
});

describe('首屏块里不许有农历数据（LUNAR-indirect-import 剩下的兜底，11-05）', () => {
  /** lunar-data.ts 里某张表 years 的前三项，原样拼成产物里的样子（数字、逗号、方括号；压缩不改这些） */
  const head3 = (name: string): string | null => {
    const src = readFileSync(join(ROOT, 'shared/logic/anniv/lunar-data.ts'), 'utf8');
    const at = src.indexOf(`export const ${name}: LunarTable = `);
    const ys = at < 0 ? -1 : src.indexOf('years: [', at);
    if (ys < 0 || src.slice(ys + 8, ys + 9) !== '[') return null;   // 没有这张表，或者这张表的 years 是空的（[]）
    const pairs = src.slice(ys + 8).split('],[').slice(0, 3);
    return pairs.length === 3 ? `${pairs.join('],[')}]` : null;
  };
  it('LUNAR_MARKS 跟着数据源走：中国农历表的前三项就是登记的那一串；韩国农历表有了数据就必须也登记', () => {
    const cn = head3('LUNAR_CN');
    expect(cn).not.toBe(null);
    expect(LUNAR_MARKS).toContain(cn);
    const kr = head3('LUNAR_KR');
    if (kr !== null) expect(LUNAR_MARKS, 'LUNAR_KR 有数据了：把它的前三项加进 build/check_first_paint_chunks.mjs 的 LUNAR_MARKS').toContain(kr);
  });
  it('农历块被首屏静态引进来（按名字认）：报出来', () => {
    const m = base();
    m['_lunar-a.js'] = { file: 'assets/lunar-a.js', name: 'lunar' };
    m['features/today/ui/TodayPage.tsx']?.imports?.push('_lunar-a.js');
    const bad = checkFirstPaint(m, text());
    expect(bad.some((b) => b.includes('农历数据的块') && b.includes('_lunar-a.js'))).toBe(true);
  });
  it('农历数据被并进首屏别的块（名字认不出）：按特征数字串报出来；只被动态 import 的农历块不算', () => {
    const m = base();
    for (const mark of LUNAR_MARKS) {
      const bad = checkFirstPaint(m, text({ 'assets/components-a.js': `const t={first:1901,years:[${mark},[-23707,2715]]};` }));
      expect(bad).toEqual([`首屏块 assets/components-a.js（_components-a.js）里有农历表的数据`]);
    }
    m['_lunar-a.js'] = { file: 'assets/lunar-a.js', name: 'lunar', isDynamicEntry: true };
    const today = m['features/today/ui/TodayPage.tsx'];
    if (today) today.dynamicImports = ['_lunar-a.js'];
    expect(checkFirstPaint(m, text({ 'assets/lunar-a.js': `const t=[${LUNAR_MARKS[0]}];` }))).toEqual([]);
  });
});

describe('接线', () => {
  it('build_web.mjs 在体积检查之后、删掉 .vite 之前跑它，它失败时构建退出码非 0', () => {
    const src = readFileSync(join(ROOT, 'build', 'build_web.mjs'), 'utf8');
    const run = src.indexOf("build/check_first_paint_chunks.mjs'), '--app-dir', APP_DIR]");
    expect(run).toBeGreaterThan(src.indexOf("build/check_size.mjs'"));
    expect(run).toBeLessThan(src.indexOf('rmSync(vm,'));
    expect(src).toContain('process.exit((size.status ?? 1) || (zodFree.status ?? 1));');
  });

  it('FIRST_PAINT_DYNAMIC 的文件都在，并且确实是首屏路径上的懒加载（今天页路由、告知页关口和它里面的告知页）', () => {
    for (const k of FIRST_PAINT_DYNAMIC as string[]) expect(existsSync(join(ROOT, 'src', k)), k).toBe(true);
    expect(readFileSync(join(ROOT, 'src/features/today/index.ts'), 'utf8')).toContain("name: 'today', Page: lazy(() => import('./ui/TodayPage.tsx'))");
    expect(readFileSync(join(ROOT, 'src/features/onboarding/index.ts'), 'utf8')).toContain("export const ConsentGate = lazy(() => import('./ui/ConsentGate.tsx'));");
    expect(readFileSync(join(ROOT, 'src/features/onboarding/ui/ConsentGate.tsx'), 'utf8')).toContain("lazy(() => import('./ConsentPage.tsx'))");
  });
});
