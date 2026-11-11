// 只有 export … from 的出口文件按无副作用打包（vite.config.ts 的 PURE_REEXPORT_RULES，11-12 首屏瘦身）。
// 守两件事：规则真的挂在 build.rollupOptions.treeshake.moduleSideEffects 上；规则认的每个文件都找得到、去掉注释以后只有 export … from
// （往出口文件里加了顶层语句就不再是无副作用，打包会把它悄悄丢掉或挪块，这里先挂）
// 注意：first-paint-lib 的依赖图把 export … from 一律算“带进来”，所以它会把这些出口转出的模块（如 AppearList）算进首屏；实际打包按本规则不进，首屏以构建的 check_size 为准
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import config, { PURE_REEXPORT_RULES } from '../../vite.config.ts';
import { ROOT, strip } from './first-paint-lib.ts';

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? (d.name === 'node_modules' ? [] : filesUnder(join(dir, d.name))) : [join(dir, d.name)],
  );
}

/** 一句一句看：只许 export { … } from '…'、export type { … } from '…'、export * from '…' */
const REEXPORT = /^export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"][^'"]+['"]$/;
const nonReexports = (src: string): string[] =>
  strip(src)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !REEXPORT.test(s));

describe('只有 export … from 的出口文件按无副作用打包（11-12 首屏瘦身）', () => {
  it('vite.config.ts 把 PURE_REEXPORT_RULES 挂在 build.rollupOptions.treeshake.moduleSideEffects 上', () => {
    type Cfg = { build: { rollupOptions: { treeshake?: { moduleSideEffects?: unknown } } } };
    const cfg = (config as unknown as (e: object) => Cfg)({ mode: 'e2e', command: 'build' });
    expect(cfg.build.rollupOptions.treeshake?.moduleSideEffects).toBe(PURE_REEXPORT_RULES);
    expect(PURE_REEXPORT_RULES.every((r) => r.sideEffects === false)).toBe(true);
  });

  it('规则认的文件都找得到，去掉注释以后只有 export … from', () => {
    const src = filesUnder(join(ROOT, 'src'));
    for (const rule of PURE_REEXPORT_RULES) {
      const hit = src.filter((f) => rule.test.test(f));
      expect(hit.length, String(rule.test)).toBeGreaterThan(0);
      for (const f of hit) expect(nonReexports(readFileSync(f, 'utf8')), relative(ROOT, f)).toEqual([]);
    }
  });

  it('拦得住：出口文件里多一句顶层语句', () => {
    expect(nonReexports("export { A } from './a.tsx';\n// 注释\nexport type { B } from './b.ts';")).toEqual([]);
    expect(nonReexports("export { A } from './a.tsx';\nconsole.log('x');")).toEqual(["console.log('x')"]);
    expect(nonReexports("import './side.css';\nexport { A } from './a.tsx';")).toEqual(["import './side.css'"]);
  });
});
