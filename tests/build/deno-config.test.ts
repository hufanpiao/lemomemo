// deno.json 里钉的 zod 版本必须和 package.json 一样（架构 2.5：shared 前后端共用，版本不一致会两边校验结果不同）
// 进程时区也核对一下：test:tz 设的 TZ 真的生效了
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const readJson = (f: string): unknown => JSON.parse(readFileSync(join(root, f), 'utf8'));

describe('deno.json', () => {
  it('zod 版本和 package.json 一致', () => {
    const pkg = readJson('package.json') as { dependencies: Record<string, string> };
    const deno = readJson('deno.json') as { imports: Record<string, string> };
    expect(deno.imports.zod).toBe(`npm:zod@${pkg.dependencies.zod}`);
  });

  it('进程时区和 TZ 环境变量一致（test:tz 用）', () => {
    const want = process.env.TZ;
    if (want) expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(want === 'UTC' ? 'UTC' : want);
  });
});
