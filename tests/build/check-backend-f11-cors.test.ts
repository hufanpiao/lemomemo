// build/check_backend.py F11（B6-exe F5 ④；架构 5.10、Q-A3；B6-exe 代码审查 M2、S6，安全审查 F5-4、建议 1）：
// supabase/functions/ 下不准出现 Access-Control-Allow-Origin（查 allow-origin 字样），也不准 import 自带 CORS 头的库；
// CORS 只在转发层 functions/_lib/cors.ts 做。函数目录里的 tests/、__tests__/、dist/ 照扫，只跳过 node_modules；读不出 UTF-8 的文件报错。
// 样例在 tests/arch-fixtures/check_backend/f11-edge-cors、f11-edge-cors-ok；node_modules 和非 UTF-8 文件不进仓库，在临时目录现拼
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run, sample, where } from './check-backend-harness.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 对照样例的副本，再加几个文件 */
function okPlus(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), 'lemo-f11-'));
  dirs.push(root);
  cpSync(sample('f11-edge-cors-ok'), root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

describe('F11：Edge Functions 不加 CORS 头', () => {
  it('违规样例：函数里 set、_shared 小写写法、.json、tests/ __tests__/ dist/ 目录里的、自带 CORS 的库、import map 别名、拼接写法都报；注释、*.test.*、转发层不报', () => {
    const { code, errors } = run(sample('f11-edge-cors'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F11 supabase/functions/_shared/__tests__/h.ts:2', // __tests__/ 照扫（F5-4）
      'F11 supabase/functions/_shared/cors.ts:3', // 小写
      'F11 supabase/functions/_shared/dist/h.ts:2', // dist/ 照扫（S6）
      'F11 supabase/functions/_shared/tests/h.ts:2', // tests/ 照扫（F5-4、BE1-S3）
      'F11 supabase/functions/deno.json:3', // import map 把别名指到 @supabase/supabase-js/cors
      'F11 supabase/functions/hello/headers.json:2', // 非 JS 文件按原文查
      'F11 supabase/functions/hello/index.ts:6', // h.set(...)；第 1、7 行注释不算
      // 按字符串排序，10～16 排在 2 前面
      'F11 supabase/functions/hello/libs.ts:10', // npm:…/dist/cors.mjs（复核 R1）
      'F11 supabase/functions/hello/libs.ts:11', // esm.sh …/dist/module/cors.js
      'F11 supabase/functions/hello/libs.ts:12', // jsdelivr …/dist/main/cors.cjs
      'F11 supabase/functions/hello/libs.ts:14', // esm.sh …/es2022/cors.mjs（代码审查建议 ①）
      'F11 supabase/functions/hello/libs.ts:15', // esm.sh …/denonext/cors.mjs
      'F11 supabase/functions/hello/libs.ts:16', // npm:…/dist/cors.min.mjs
      'F11 supabase/functions/hello/libs.ts:2', // npm:@supabase/supabase-js@2.118.0/cors（M2）
      'F11 supabase/functions/hello/libs.ts:3', // jsr:@hono/hono/cors
      'F11 supabase/functions/hello/libs.ts:4', // esm.sh 百分号编码的 %40supabase
      'F11 supabase/functions/hello/libs.ts:6', // 动态 import('npm:cors@2.8.5')
      'F11 supabase/functions/hello/libs.ts:8', // 'Access-Control-' + 'Allow-Origin'（建议 1，放宽到 allow-origin）
    ]);
    for (const e of errors) expect(e.message).toContain('CORS 只在转发层 functions/_lib/cors.ts 做');
    const libs = errors.filter((e) => e.file.endsWith('libs.ts') && e.line !== 8);
    for (const e of libs) expect(e.message).toContain('自带 CORS 头的库');
  });

  it('对照样例：0 个错误（supabase-js 本体、本地文件、干净的 tests/ 都不误伤）', () => {
    expect(run(sample('f11-edge-cors-ok'))).toEqual({ code: 0, errors: [] });
  });

  it('只跳过 node_modules：里面写了也不报（依赖目录本来不进仓库）', () => {
    const root = okPlus({ 'supabase/functions/node_modules/x/index.js': "module.exports = { 'Access-Control-Allow-Origin': '*' };\n" });
    expect(run(root)).toEqual({ code: 0, errors: [] });
  });

  it('读不出 UTF-8 的文件：报一条“检查不了”，不再悄悄跳过（S6）', () => {
    // GBK 编码的“跨域”两个字，不是合法 UTF-8
    const root = okPlus({ 'supabase/functions/hello/notes.toml': new Uint8Array([0x23, 0x20, 0xbf, 0xe7, 0xd3, 0xf2, 0x0a]) });
    const { code, errors } = run(root);
    expect(code).toBe(1);
    expect(where(errors)).toEqual(['F11 supabase/functions/hello/notes.toml:1']);
    expect(errors[0]?.message).toContain('不是合法的 UTF-8');
  });
});
