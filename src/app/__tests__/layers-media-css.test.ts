// 层级和断点的“唯一出口”防回退（架构 10.1；界面去重返修 11-11）：jsdom 不算布局，按源码文字核对。
// • 层级：base.css :root 的 --z-* 按声明顺序从低到高；src 下的 CSS 只写 var(--z-*)、auto 或 -1～2 的组件内小数，
//   用到的变量都有定义。例外只有启动画面和启动探针（在 React 和 base.css 之前画，写最大的数，见 base.css 层级表的注释）
// • 断点：CSS 媒体查询里不能用变量，JS 里也要判的两个断点（kit/hooks/useMedia.ts 的 MQ_SIDEBAR、MQ_CAL_WIDE）在 CSS 里照写同一个数，
//   这里核：写这两个断点的 CSS 文件都用的是常量里的数；src 下宽度 ≥ 700 的 min 方向断点只有侧栏这一个
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MQ_CAL_WIDE, MQ_SIDEBAR } from '../../kit/hooks/useMedia.ts';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n).replaceAll('\\', '/');
    if (statSync(p).isDirectory()) return n === '__tests__' ? [] : walk(p);
    return p.endsWith('.css') ? [p] : [];
  });
}

const noComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const FILES = walk('src').map((f) => [f, noComments(readFileSync(f, 'utf8'))] as const);
const base = noComments(readFileSync('src/styles/base.css', 'utf8'));
/** 启动画面：在 base.css 之前画，层级写最大的数（base.css 层级表的注释） */
const SPLASH = new Set(['src/styles/splash.css']);

describe('层级（z-index）', () => {
  const table = [...base.matchAll(/(--z-[a-z-]+):\s*(-?\d+);/g)].map((m) => [m[1] ?? '', Number(m[2])] as const);

  it('base.css 的 --z-* 按声明顺序从低到高、不重名', () => {
    expect(table.length).toBeGreaterThan(10);
    expect(new Set(table.map(([n]) => n)).size).toBe(table.length);
    for (let i = 1; i < table.length; i++) expect(table[i]?.[1], `${table[i]?.[0]} 要比 ${table[i - 1]?.[0]} 高`).toBeGreaterThan(table[i - 1]?.[1] ?? 0);
  });

  it('src 下的 CSS 只写 var(--z-*)、auto 或 -1～2；用到的变量都有定义（启动画面、启动探针除外）', () => {
    const defined = new Set(table.map(([n]) => n));
    const bad: string[] = [];
    for (const [f, css] of FILES) {
      for (const m of css.matchAll(/z-index:\s*([^;}]+)/g)) {
        const v = (m[1] ?? '').trim();
        const ref = v.match(/^var\((--z-[a-z-]+)\)$/)?.[1];
        const ok = ref ? defined.has(ref) : v === 'auto' || (/^-?\d+$/.test(v) && Number(v) >= -1 && Number(v) <= 2) || SPLASH.has(f);
        if (!ok) bad.push(`${f}: z-index: ${v}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('断点', () => {
  const px = (q: string): number => Number(q.match(/(\d+)px/)?.[1]);
  const sidebar = px(MQ_SIDEBAR);
  const cal = px(MQ_CAL_WIDE);

  it('侧栏断点：GlassBar、GlassBarFx、MeLink、随手记页、base.css 的媒体查询都是 useMedia.ts 里 MQ_SIDEBAR 的数', () => {
    for (const f of ['src/kit/components/GlassBar/GlassBar.module.css', 'src/kit/components/GlassBar/GlassBarFx.module.css', 'src/kit/components/MeLink.module.css', 'src/features/notes/ui/NotesPage.module.css', 'src/styles/base.css']) {
      expect(noComments(readFileSync(f, 'utf8')), f).toContain(`@media (width >= ${sidebar}px)`);
    }
  });

  it('src 下宽度 ≥ 700 的“至少多宽”断点只有侧栏这一个数（换断点要同时改 useMedia.ts 和这些 CSS）', () => {
    const others = FILES.flatMap(([f, css]) =>
      [...css.matchAll(/@media[^{]*\(width >= (\d+)px\)/g)].map((m) => Number(m[1])).filter((n) => n >= 700 && n !== sidebar).map((n) => `${f}: ${n}px`),
    );
    expect(others).toEqual([]);
  });

  it('月历宽屏断点：CalendarPage.module.css 的窄屏媒体查询正好是 MQ_CAL_WIDE 的反面', () => {
    expect(MQ_CAL_WIDE).toBe(`(min-width: ${cal}px)`);
    expect(noComments(readFileSync('src/features/calendar/ui/CalendarPage.module.css', 'utf8'))).toContain(`@media (width < ${cal}px)`);
  });
});
