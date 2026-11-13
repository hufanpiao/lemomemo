// build/check_backend.py F13、F14（B5 任务单 S2、S8；TC-B0-75）：
// • F13：隐私记的函数目录（vault*）里不准用 console；共用模块、别的函数不归它管。样例在 tests/arch-fixtures/check_backend/f13-vault-console
// • F14：objstore 的 put、storage 的 upload / update 实参里必须写出 contentType。样例在 tests/arch-fixtures/check_backend/f14-content-type
//   （违规两处：Uint8Array 不带 contentType 往 vault-preview、backups 传）
import { describe, expect, it } from 'vitest';
import { run, sample, SLOW_TIMEOUT, where } from './check-backend-harness.ts';

describe('F13：隐私记函数目录不准用 console', () => {
  it('vault、vault-image 里的 console.log、console[...] 都报；hello 和 _shared 不报', () => {
    const { code, errors } = run(sample('f13-vault-console'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F13 supabase/functions/vault-image/index.ts:2',
      'F13 supabase/functions/vault/core.ts:3',
    ]);
    for (const e of errors) expect(e.message).toContain('codeLogger');
  }, SLOW_TIMEOUT);
});

describe('F14：上传一律显式带 contentType（TC-B0-75）', () => {
  it('put、upload 没写 contentType 的两处报；写明的、简写的、表的 update、注释不报', () => {
    const { code, errors } = run(sample('f14-content-type'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F14 supabase/functions/hello/backup.ts:4',
      'F14 supabase/functions/hello/r2.ts:4',
    ]);
    for (const e of errors) expect(e.message).toContain('contentType');
  }, SLOW_TIMEOUT);
});
