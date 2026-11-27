// build/check_backend.py F12（架构约定 10.1）：服务器函数的 json 响应只在 _shared/http.ts 做（一律 no-store、同一个 content-type）。
// 别处出现 new Response(JSON.stringify( 或自己定义 function json( 就报；流式响应、引共用的 json 不报。样例在 tests/arch-fixtures/check_backend/f12-json-response
import { describe, expect, it } from 'vitest';
import { run, sample, where } from './check-backend-harness.ts';

describe('F12：json 响应只在 _shared/http.ts', () => {
  it('违规样例：函数里 new Response(JSON.stringify(、另定义 function json( 都报；_shared/http.ts、注释、流式响应不报', () => {
    const { code, errors } = run(sample('f12-json-response'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F12 supabase/functions/hello/core.ts:2',
      'F12 supabase/functions/hello/index.ts:2',
    ]);
    for (const e of errors) expect(e.message).toContain('_shared/http.ts');
  });
});
