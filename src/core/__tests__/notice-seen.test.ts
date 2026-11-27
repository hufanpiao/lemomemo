// 启动时用本机缓存判定“已经看过要求的隐私说明版本”（冷启动不等服务器，core/notice-seen.ts）
import { describe, expect, it } from 'vitest';
import { policyVerAtLeast, seenNotice } from '../notice-seen.ts';

const cfg = (min: unknown): Record<string, unknown> => ({ notice: { policy_ver: '2026-11-01', min_consent_ver: min } });

describe('seenNotice', () => {
  it('看过的版本不低于要求的：算看过（含同一天的第几版，按数字比不按字典序）', () => {
    expect(seenNotice({ consent_policy_ver: '2026-11-01' }, cfg('2026-10-01'))).toBe(true);
    expect(seenNotice({ consent_policy_ver: '2026-11-01' }, cfg('2026-11-01'))).toBe(true);
    expect(seenNotice({ consent_policy_ver: '2026-11-01-10' }, cfg('2026-11-01-2'))).toBe(true);
  });

  it('看过的版本低于要求的：没看过（走关口，出“隐私说明更新了”）', () => {
    expect(seenNotice({ consent_policy_ver: '2026-10-01' }, cfg('2026-11-01'))).toBe(false);
    expect(seenNotice({ consent_policy_ver: '2026-11-01-2' }, cfg('2026-11-01-10'))).toBe(false);
  });

  it('本人版本没有、是空的、认不出，或者还没有缓存的 profile：没看过', () => {
    expect(seenNotice(null, cfg('2026-10-01'))).toBe(false);
    expect(seenNotice({ consent_policy_ver: null }, cfg('2026-10-01'))).toBe(false);
    expect(seenNotice({ consent_policy_ver: '' }, cfg('2026-10-01'))).toBe(false);
    expect(seenNotice({ consent_policy_ver: 'v3' }, cfg('2026-10-01'))).toBe(false);
  });

  it('要求的版本没有、认不出、没有缓存的 config：当没有要求，本人看过就算看过（同关口的判定）', () => {
    expect(seenNotice({ consent_policy_ver: '2026-11-01' }, null)).toBe(true);
    expect(seenNotice({ consent_policy_ver: '2026-11-01' }, {})).toBe(true);
    expect(seenNotice({ consent_policy_ver: '2026-11-01' }, cfg('最新'))).toBe(true);
    expect(seenNotice({ consent_policy_ver: '2026-11-01' }, { notice: 'x' })).toBe(true);
  });
});

describe('policyVerAtLeast', () => {
  it('认不出的一律否', () => {
    expect(policyVerAtLeast('2026-11-01', null)).toBe(false);
    expect(policyVerAtLeast('x', '2026-11-01')).toBe(false);
  });
});
