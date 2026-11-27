// 底栏渐隐层遮罩的产物检查（build/check_glass_css.mjs，B12 代码审查 11-06）：GlassBarFx 的 CSS 里必须有 -webkit-mask-composite:source-out 和标准写法
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { glassCssFiles, glassMaskProblems } from '../../build/check_glass_css.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('底栏渐隐层遮罩（build/check_glass_css.mjs）', () => {
  it('两种写法都在才算过；缺前缀、缺标准写法、都没有都拦得住', () => {
    const ok = '._edge_x{-webkit-mask-composite:source-out,source-over,source-over;mask-composite:subtract,add,add}';
    expect(glassMaskProblems(ok)).toEqual([]);
    expect(glassMaskProblems('._edge_x{mask-composite:subtract,add,add}')).toHaveLength(1);
    expect(glassMaskProblems('._edge_x{-webkit-mask-composite:source-out}')).toHaveLength(1);
    expect(glassMaskProblems('._edge_x{color:red}')).toHaveLength(2);
    // 只认 source-out 这一个词，不认 source-over 打头的
    expect(glassMaskProblems('._edge_x{-webkit-mask-composite:source-over;mask-composite:subtract}')).toHaveLength(1);
  });
  it('源码写的是标准写法 mask-composite: subtract（前缀由构建补）', () => {
    const src = readFileSync(join(ROOT, 'src/kit/components/GlassBar/GlassBarFx.module.css'), 'utf8');
    expect(src).toMatch(/mask-composite: subtract,/);
  });
  // 只查比源码新的产物：本机 dist/web 可能是很久以前构建的（那时还没有渐隐层），旧产物不算数
  const srcTime = statSync(join(ROOT, 'src/kit/components/GlassBar/GlassBarFx.module.css')).mtimeMs;
  const files = glassCssFiles(join(ROOT, 'dist', 'web', 'app')).filter((f) => statSync(f).mtimeMs >= srcTime);
  it.skipIf(files.length === 0)('dist/web/app 里比源码新的产物（构建过才查；build_web.mjs 每次构建都会跑同一个检查）', () => {
    for (const f of files) expect(glassMaskProblems(readFileSync(f, 'utf8')), f).toEqual([]);
  });
});
