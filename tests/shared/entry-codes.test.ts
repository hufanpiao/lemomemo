// 入口共用码（shared/schema/entry-codes.ts，接手清单 ENTRY-codes）：只引 shared 的部分（vitest 和 Deno 的 deno task test 都跑）。
// 前端三处（邀请注册、登录页 restore、设置页 account）的映射要引 src，放在 vitest 专用的 tests/build/entry-codes-mapping.test.ts
import { describe, expect, it } from 'vitest';
import { ACCOUNT_ERROR_CODES } from '../../shared/schema/account.ts';
import { ENTRY_CODE_KIND, ENTRY_ERROR_CODES, isEntryErrorCode } from '../../shared/schema/entry-codes.ts';

describe('入口共用码', () => {
  it('不和 account 的码表重叠（不放进 ACCOUNT_ERROR_CODES）；isEntryErrorCode 只认自己的码', () => {
    expect(ENTRY_ERROR_CODES.filter((c) => (ACCOUNT_ERROR_CODES as readonly string[]).includes(c))).toEqual([]);
    expect(Object.keys(ENTRY_CODE_KIND).sort()).toEqual([...ENTRY_ERROR_CODES].sort());
    for (const v of ['constructor', 'toString', '', 'try_later', null, 5]) expect(isEntryErrorCode(v), String(v)).toBe(false);
    for (const c of ENTRY_ERROR_CODES) expect(isEntryErrorCode(c), c).toBe(true);
  });
});
