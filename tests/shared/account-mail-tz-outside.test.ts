// 账号信里表外时区的说法在真运行环境（Deno）的 ICU 下也站得住（接手清单 KO-mail-tz-low L2，代码审查 11-05）：
// tests/functions/account-mail-nolink.test.ts 的同类期望只在 Node 的 ICU 下跑过，生产是 Deno（Supabase Edge），两边 ICU 字样可能不同。
// 本文件在 tests/shared 下，Vitest（Node）和 deno task test（Deno）都跑：只断言“不含拉丁字母，或退回 IANA 名（规范名）”这一层，
// 不写死具体字样。account-mail.ts 只用 Intl、不 import npm 包，Deno 下直接能引。
import { describe, expect, it } from 'vitest';
import { canonicalTz, tzLabel } from '../../shared/i18n/tz-label.ts';
import { fmtWhen, safeTz } from '../../supabase/functions/_shared/account-mail.ts';

const AT = Date.parse('2026-11-07T03:00:00Z');
const OUTSIDE = ['America/Toronto', 'Asia/Kolkata', 'Asia/Dubai', 'Pacific/Auckland'];

describe('表外时区：账号信括号里的说法（Node、Deno 各跑一遍）', () => {
  for (const loc of ['zh-CN', 'ko-KR'] as const) {
    it(`${loc}：不含拉丁字母，或退回规范后的 IANA 名；不是空的`, () => {
      for (const z of OUTSIDE) {
        const label = tzLabel(safeTz(z), loc);
        expect(label, `${loc} ${z}`).not.toBe('');
        expect(label === canonicalTz(z) || !/[A-Za-z]/.test(label), `${loc} ${z} → ${label}`).toBe(true);
        const when = fmtWhen(AT, z, loc, tzLabel);
        expect(when.endsWith(loc === 'ko-KR' ? `(${label})` : `（${label}）`), `${loc} ${z} → ${when}`).toBe(true);
      }
    });
  }

  it('大小写变体、旧别名先规范化：asia/seoul、ROK 写成“한국 시간 / 韩国时间”', () => {
    expect(fmtWhen(AT, 'asia/seoul', 'ko-KR', tzLabel)).toBe('2026년 11월 7일 12:00 (한국 시간)');
    expect(fmtWhen(AT, 'ROK', 'zh-CN', tzLabel)).toBe('2026年11月7日 12:00（韩国时间）');
  });
});
