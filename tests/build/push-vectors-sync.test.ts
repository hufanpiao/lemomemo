// supabase/tests/rls/29_push_endpoint_vectors.test.sql 必须是由当前 tests/fixtures/push-endpoints.json 生成的（B2 TC-B2-80、安全审查 D1-3：
// 两边读同一组向量）。fixture 改了忘了重新生成，这里拦。生成：node build/gen_push_vectors.mjs
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE, OUT, render } from '../../build/gen_push_vectors.mjs';

describe('推送向量 pgTAP 文件和 fixture 同步', () => {
  it('29_push_endpoint_vectors.test.sql 等于按 fixture 重新生成的结果', () => {
    const want = render(JSON.parse(readFileSync(FIXTURE as string, 'utf8'))) as string;
    expect(readFileSync(OUT as string, 'utf8')).toBe(want);
  });
});
