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

  it('rewrite：相对 import 没有 .ts 后缀、引了别的包 → 报问题', () => {
    expect(rewrite("import { a } from './a';", 'x.ts', '4.6.7').problems).toHaveLength(1);
    expect(rewrite("import React from 'react';", 'x.ts', '4.6.7').problems).toHaveLength(1);
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
