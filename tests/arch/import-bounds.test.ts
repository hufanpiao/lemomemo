// 架构 2.3 R2、LUNAR、MOTION-IMPL：ESLint 规则 lemo/import-bounds（build/eslint-rules/import-bounds.js）。
// 11-14 CI-11 从 build/check_arch.py 挪来，样例目录原样搬到 tests/arch-fixtures/import-bounds/（原 check_arch 的 5 个样例，期望的文件和行号不变）。
// 每个样例是一棵迷你仓库：ESLint 的 cwd 指过去，只挂这一条规则；另用真仓库的 eslint.config.js 证明规则确实接上了、真仓库的变异拦得住
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import lemo from '../../build/eslint-rules/index.js';
import { FIXTURES, ROOT } from './fixture-header.ts';

interface Hit {
  rule: string;
  file: string;
  line: number;
  message: string;
}

async function lintSample(name: string): Promise<Hit[]> {
  const cwd = join(FIXTURES, 'import-bounds', name);
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*.{ts,tsx,js,mjs}'],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { lemo: lemo as unknown as ESLint.Plugin }, // 自写规则是 JS，meta.type 推成 string，和 ESLint 的类型对不上
      // 规则默认按自己文件的位置推仓库根（不看 cwd），样例是迷你仓库，用选项指过去
      rules: { 'lemo/import-bounds': ['error', { root: cwd }] },
    },
  });
  const results = await eslint.lintFiles(['.']);
  const hits = results.flatMap((r) =>
    r.messages.map((m) => {
      expect(m.fatal, `${r.filePath} 要能解析：${m.message}`).toBeFalsy();
      return { rule: m.message.split('：')[0] ?? '', file: relative(cwd, r.filePath).replace(/\\/g, '/'), line: m.line, message: m.message };
    }),
  );
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
const where = (hits: Hit[]) => hits.map((e) => `${e.rule} ${e.file}:${e.line}`);

describe('lemo/import-bounds（tests/arch-fixtures/import-bounds）', { timeout: 60_000 }, () => {
  it('R2：src 里 import shared/objstore.ts、aws4fetch（含动态 import）、functions/ 的生成表 → 错误', async () => {
    expect(where(await lintSample('r2-import'))).toEqual([
      'R2 src/app/bad.ts:2',
      'R2 src/features/notes/data/bad.ts:2',
      'R2 src/platform/bad.ts:2',
      'R2 src/platform/bad.ts:4',
    ]);
  });

  it('LUNAR：src 里静态 import / export from / 只写路径的 import / require 农历模块 → 错误；import()、import type、注释、别的 lunar 模块放行', async () => {
    expect(where(await lintSample('lunar-static-import'))).toEqual([
      'LUNAR src/features/calendar/hooks/bad.ts:2',
      'LUNAR src/features/calendar/hooks/bad.ts:3',
      'LUNAR src/features/calendar/hooks/bad.ts:4',
      'LUNAR src/features/calendar/hooks/bad.ts:5',
      'LUNAR src/features/calendar/hooks/bad.ts:6',
    ]);
  });

  it('LUNAR 间接（LUNAR-indirect-import）：src 静态引入 shared 的模块、它再静态引入农历（隔一层、两层、环里都算）→ 错误；动态 import()、import type、链上有 import() 或 import type 断开的放行', async () => {
    const hits = await lintSample('lunar-indirect-import');
    expect(hits.map((e) => `${e.file}:${e.line}`)).toEqual([
      'src/features/today/cyc1.ts:2',
      'src/features/today/cyc2.ts:2', // 从环的另一头进
      'src/features/today/direct.ts:2', // 直接
      'src/features/today/one.ts:2', // 隔一层（同目录 './lunar.ts' 写法）
      'src/features/today/two.ts:2', // 隔两层：import
      'src/features/today/two.ts:3', //          export … from（不带扩展名）
      'src/features/today/two.ts:4', //          只写路径的 import
    ]);
    expect(hits.every((e) => e.rule === 'LUNAR')).toBe(true);
    const msg = (f: string) => hits.find((e) => e.file === f)?.message ?? '';
    expect(msg('src/features/today/direct.ts')).toContain('农历数据只能按需加载');
    expect(msg('src/features/today/one.ts')).toContain('shared/logic/anniv/next-date.ts → shared/logic/anniv/lunar.ts');
    expect(msg('src/features/today/two.ts')).toContain('shared/logic/mid.ts → shared/logic/anniv/next-date.ts → shared/logic/anniv/lunar.ts');
    expect(msg('src/features/today/cyc2.ts')).toContain('shared/logic/cyc-b.ts → shared/logic/cyc-a.ts → shared/logic/anniv/lunar.ts');
  });

  it('MOTION-IMPL：该报的——功能 ui、门面、index.ts 的 import()、export from、require、只写路径、import { type X }、功能代码的 import type、shared/、子目录和 .ts 的 *-impl、静态或别处动态引实现文件', async () => {
    const hits = await lintSample('motion-impl-bad');
    expect(hits.every((e) => e.rule === 'MOTION-IMPL')).toBe(true);
    expect(hits.map((e) => `${e.file}:${e.line}`).sort()).toEqual([
      'shared/logic/anim.ts:2', // shared/ 下引 motion-utils 子路径
      'src/features/today/ui/Row.tsx:2', // 功能 ui 里 import { m } from 'motion/react'
      'src/features/today/ui/types.ts:2', // import type 只在 src/motion/ 下放行
      'src/motion/Appear.tsx:2', // 门面静态引 motion/react
      'src/motion/Appear.tsx:3', // 门面静态引 ./list-impl.tsx
      'src/motion/a-impl.ts:2', // .ts 结尾的不算实现文件
      'src/motion/deftype.ts:2', // import type from 'motion'：默认导入起名叫 type，不算纯类型
      'src/motion/index.ts:2', // import('motion/react')
      'src/motion/index.ts:3', // import('./motion-impl.tsx') 只准 features.ts
      'src/motion/reexport.ts:2', // export { m } from 'framer-motion'
      'src/motion/req.ts:3', // require('motion')
      'src/motion/side.ts:2', // import 'motion-dom'
      'src/motion/sub/a-impl.tsx:2', // 子目录里的 *-impl.tsx 不算
      'src/motion/typed.ts:2', // import { type FeatureBundle } 不算纯类型
    ].sort());
    const msg = (f: string, line: number) => hits.find((e) => e.file === f && e.line === line)?.message ?? '';
    expect(msg('src/motion/Appear.tsx', 2)).toContain('只有 src/motion/*-impl.tsx 能引入 motion/react');
    expect(msg('src/motion/Appear.tsx', 3)).toContain('动画实现 ./list-impl.tsx 只能由 src/motion/features.ts 用 import() 动态加载');
    expect(msg('src/motion/index.ts', 3)).toContain('动画实现 ./motion-impl.tsx');
    expect(msg('src/motion/reexport.ts', 2)).toContain('能引入 framer-motion');
  });

  it('MOTION-IMPL：不报的——*-impl.tsx 和 motion-impl.tsx 引 motion、features.ts 的 import type 和 import(./motion-impl.tsx)、motion-impl.tsx 静态引别的实现、注释、__tests__ 和 *.test.ts、带 ${} 的反引号、解析到样例外的', async () => {
    expect(await lintSample('motion-impl-ok')).toEqual([]);
  });
});

// 真仓库的 eslint.config.js：规则挂上了（src、shared 都管），真文件改坏一处就报；lintText 只在内存里改，不动工作区
describe('lemo/import-bounds 接在真仓库的 ESLint 配置上', { timeout: 120_000 }, () => {
  const eslint = new ESLint({ cwd: ROOT });
  const errorsOf = async (path: string, code: string) => {
    const [res] = await eslint.lintText(code, { filePath: join(ROOT, path) });
    return (res?.messages ?? []).filter((m) => m.ruleId === 'lemo/import-bounds').map((m) => m.message.split('：')[0]);
  };
  const real = (path: string) => readFileSync(join(ROOT, path), 'utf8');

  it('真文件原样 0 条；Appear.tsx 加 motion/react 引入 → MOTION-IMPL；features.ts 的 import type 改成 import → MOTION-IMPL', async () => {
    const appear = real('src/motion/Appear.tsx');
    expect(await errorsOf('src/motion/Appear.tsx', appear)).toEqual([]);
    expect(await errorsOf('src/motion/Appear.tsx', `import { m } from 'motion/react';\nexport const __mut = m;\n${appear}`)).toEqual(['MOTION-IMPL']);
    const features = real('src/motion/features.ts');
    const typeImport = /^import type (\{[^}]*\}) from 'motion\/react';(?=\r?$)/m;
    expect(features, 'features.ts 里要有 motion/react 的 import type（变异的前提）').toMatch(typeImport);
    expect(await errorsOf('src/motion/features.ts', features)).toEqual([]);
    expect(await errorsOf('src/motion/features.ts', features.replace(typeImport, "import $1 from 'motion/react';"))).toEqual(['MOTION-IMPL']);
  });

  it('src/core/anniv-lib.ts 的 import() 改成静态 import → LUNAR（next-date 经 shared 再引农历）；功能 data 引 aws4fetch → R2；shared 引 motion → MOTION-IMPL', async () => {
    const lib = real('src/core/anniv-lib.ts');
    expect(await errorsOf('src/core/anniv-lib.ts', lib)).toEqual([]);
    const mutated = `import * as __nd from '../../shared/logic/anniv/next-date.ts';\nexport const __mut = __nd;\n${lib}`;
    expect(await errorsOf('src/core/anniv-lib.ts', mutated)).toEqual(['LUNAR']);
    expect(await errorsOf('src/features/notes/data/mut.ts', "export const a = () => import('aws4fetch');\n")).toEqual(['R2']);
    expect(await errorsOf('shared/logic/mut.ts', "export { animate } from 'motion';\n")).toEqual(['MOTION-IMPL']);
  });

  it('./x.js 按 TS 的写法对上 x.tsx（11-14 整块评审：原来只试 x.ts，写 .js 的引入绕得过 MOTION-IMPL）', async () => {
    expect(await errorsOf('src/motion/mut.ts', "export * from './list-impl.js';\n")).toEqual(['MOTION-IMPL']);
    expect(await errorsOf('src/motion/mut.ts', "export * from './list-impl';\n")).toEqual(['MOTION-IMPL']);
  });

  it('ESLint 的 cwd 不是仓库根（在 src/ 里跑）：仓库根照样按规则文件的位置推，该报的照报（原来用 context.cwd，src/ 判断全错、悄悄不报）', async () => {
    // 不指定配置文件：ESLint 从文件位置往上找到仓库根的 eslint.config.js（和在 src/ 里直接敲 npx eslint 一样），context.cwd 是 src/
    const sub = new ESLint({ cwd: join(ROOT, 'src') });
    const lib = real('src/core/anniv-lib.ts');
    const mutated = `import * as __nd from '../../shared/logic/anniv/next-date.ts';\nexport const __mut = __nd;\n${lib}`;
    const [res] = await sub.lintText(mutated, { filePath: join(ROOT, 'src/core/anniv-lib.ts') });
    expect((res?.messages ?? []).filter((m) => m.ruleId === 'lemo/import-bounds').map((m) => m.message.split('：')[0])).toEqual(['LUNAR']);
  });
});
