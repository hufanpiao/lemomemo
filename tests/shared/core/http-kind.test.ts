// shared/core/http-kind.ts：HTTP 状态码归类全仓一份（11-18 全 app 评审加密组第 5 条），408、429 一律算稍后再试那一类。Node 和 Deno 都跑
import { describe, expect, it } from 'vitest';
import { httpKind, isRetryStatus } from '../../../shared/core/http-kind.ts';

describe('httpKind', () => {
  it('各状态码的归类', () => {
    const want: [number, string][] = [
      [200, 'ok'], [204, 'ok'], [299, 'ok'],
      [401, 'auth'], [426, 'upgrade'], [429, 'rate_limited'],
      [408, 'try_later'], [500, 'try_later'], [502, 'try_later'], [503, 'try_later'], [504, 'try_later'], [546, 'try_later'], [599, 'try_later'],
      [404, 'not_found'], [413, 'too_large'],
      [400, 'client'], [403, 'client'], [409, 'client'], [415, 'client'], [423, 'client'], [0, 'client'], [-1, 'client'], [302, 'client'], [600, 'client'],
    ];
    for (const [s, k] of want) expect([s, httpKind(s)]).toEqual([s, k]);
  });
  it('isRetryStatus：只有限流、超时、5xx', () => {
    expect([408, 429, 500, 546].every(isRetryStatus)).toBe(true);
    expect([0, 200, 400, 401, 403, 404, 413, 426].some(isRetryStatus)).toBe(false);
  });
});
