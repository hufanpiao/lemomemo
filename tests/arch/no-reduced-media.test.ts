// “减少透明效果 / 减少动态效果”只有一处判断（皮肤整块评审 11-14 第 1、6 条；架构 17.2 第 5 点；ADR-008 实现说明）：
// platform/look.ts 把“设置里的开关打开 或 系统设置了 reduce”写成 <html data-rt="1"> / data-rm="1"，其余地方只认这两个属性。
// 本测试扫 src 下的源码（不含测试）：
// • CSS 里不许再出现 prefers-reduced-* 媒体查询，只有启动画面 src/styles/splash.css 例外（它要在 look.ts 加载之前生效）；
// • TS / TSX 里不许 matchMedia 查 prefers-reduced-*，只有 look.ts（判断）和 diag-info.ts（诊断页如实显示系统设置）例外。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './fixture-header.ts';

const CSS_ALLOWED = new Set(['src/styles/splash.css']);
const TS_ALLOWED = new Set(['src/platform/look.ts', 'src/platform/diag-info.ts']);
const CSS_RE = /@media[^{]*prefers-reduced-/;
const TS_RE = /matchMedia\([^)]*prefers-reduced-/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'public' || e.name === '__tests__' ? [] : files(p);
    return /\.(css|ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** 违规的文件（相对仓库根，正斜杠） */
export function reducedMediaHits(entries: ReadonlyArray<{ file: string; text: string }>): string[] {
  return entries
    .filter(({ file, text }) => (file.endsWith('.css') ? !CSS_ALLOWED.has(file) && CSS_RE.test(text) : !TS_ALLOWED.has(file) && TS_RE.test(text)))
    .map((e) => e.file);
}

describe('减少透明 / 减少动态只认 data-rt、data-rm', () => {
  it('src 下除 splash.css、look.ts、diag-info.ts 外没有 prefers-reduced-* 判断', () => {
    const src = join(ROOT, 'src');
    const entries = files(src).map((p) => ({ file: relative(ROOT, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') }));
    expect(entries.length).toBeGreaterThan(50);
    expect(reducedMediaHits(entries)).toEqual([]);
  });

  it('守卫本身认得出违规写法', () => {
    expect(
      reducedMediaHits([
        { file: 'src/x/A.module.css', text: '@media (prefers-reduced-transparency: reduce) { .a { color: red; } }' },
        { file: 'src/x/B.css', text: '@media (width < 600px) and (prefers-reduced-motion: reduce) {}' },
        { file: 'src/x/c.ts', text: "matchMedia('(prefers-reduced-motion: reduce)')" },
        { file: 'src/styles/splash.css', text: '@media (prefers-reduced-motion: reduce) {}' },
        { file: 'src/platform/look.ts', text: "matchMedia('(prefers-reduced-motion: reduce)')" },
        { file: 'src/x/d.ts', text: '// 系统设置了 prefers-reduced-motion: reduce 时 look.ts 写 data-rm' },
      ]),
    ).toEqual(['src/x/A.module.css', 'src/x/B.css', 'src/x/c.ts']);
  });
});
