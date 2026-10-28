// build/copy_shared.mjs（架构 2.5）：shared 复制给 Edge Functions，zod 改成钉版本的 npm: 写法
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { copyShared, rewrite } from '../../build/copy_shared.mjs';

const out = mkdtempSync(join(tmpdir(), 'lemo-shared-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('copy_shared', () => {
  it('rewrite：zod → npm:zod@版本；相对 import 保留', () => {
    const r = rewrite("import { z } from 'zod';\nimport { a } from './a.ts';\n", 'x.ts', '4.6.7');
    expect(r.problems).toEqual([]);
    expect(r.code).toContain("from 'npm:zod@4.6.7'");
    expect(r.code).toContain("from './a.ts'");
  });

  it('rewrite：aws4fetch → npm:aws4fetch@锁的版本（shared/objstore.ts，架构 0.32、8.6）', () => {
    const r = rewrite("import { AwsV4Signer } from 'aws4fetch';\n", 'objstore.ts', { zod: '4.6.7', aws4fetch: '1.0.20' });
    expect(r.problems).toEqual([]);
    expect(r.code).toContain("from 'npm:aws4fetch@1.0.20'");
    expect(rewrite("import { AwsV4Signer } from 'aws4fetch';", 'x.ts', { zod: '4.6.7' }).problems).toHaveLength(1);
  });

  it('真的 objstore.ts 复制过去以后 aws4fetch 带的是 package.json 锁的版本', () => {
    copyShared(out);
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const code = readFileSync(join(out, 'objstore.ts'), 'utf8');
    expect(code).toContain(`from 'npm:aws4fetch@${pkg.dependencies.aws4fetch}'`);
    expect(pkg.dependencies.aws4fetch).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('rewrite：相对 import 没有 .ts 后缀、引了别的包 → 报问题', () => {
    expect(rewrite("import { a } from './a';", 'x.ts', '4.6.7').problems).toHaveLength(1);
    expect(rewrite("import React from 'react';", 'x.ts', '4.6.7').problems).toHaveLength(1);
  });

  it('rewrite：npm: / jsr: / http(s): 不再原样放行，动态 import 只准写字面量（B1 S8 代码审查：gen/ 里不许出现锁外的依赖）', () => {
    const v = { zod: '4.6.7', aws4fetch: '1.0.20' };
    for (const bad of [
      "import { z } from 'npm:zod';",
      "import ms from 'npm:ms@2.1.3';",
      "import { z } from 'npm:zod@4.6.7';", // 写全也不行：版本只由 package.json 经改写给出
      "import 'jsr:@std/assert@1.0.0';",
      'import "https://deno.land/std@0.224.0/assert/mod.ts";',
      "export * from 'http://example.com/x.ts';",
      'await import(`npm:ms@2.1.3`);',
      "const p = 'npm:' + 'ms@2.1.3'; await import(p);",
      "await import('npm:' + 'ms@2.1.3');",
    ]) {
      expect(rewrite(bad, 'x.ts', v).problems.length, bad).toBeGreaterThan(0);
    }
    expect(rewrite("const m = await import('./a.ts');", 'x.ts', v).problems).toEqual([]);
  });

  it('真的 shared 能完整复制过去，且不再有裸的 zod', () => {
    const files = copyShared(out);
    expect(files).toContain('core/date.ts');
    expect(files).toContain('schema/rows.ts');
    for (const f of files) expect(existsSync(join(out, f))).toBe(true);
    const rows = readFileSync(join(out, 'schema', 'rows.ts'), 'utf8');
    expect(rows).toMatch(/from 'npm:zod@\d+\.\d+\.\d+'/);
    expect(rows).not.toMatch(/from 'zod'/);
    expect(rows.startsWith('// 生成文件')).toBe(true);
  });
});
