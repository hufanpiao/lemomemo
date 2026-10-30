// 错误码 → 提示文案的穷尽映射（接手清单 R272-sugg ④；架构 0.29 续第 119 条②；TC-B1-90）：
// try_later 单独一个分支、提示“服务器忙，稍后再试”（韩文 settings.err.tryLater，R-106 已审），不落进通用的 unknown；
// 下面两张表用 satisfies Record<…> 列全所有错误码：以后加了新码，表和 switch 都得补，编译不过就会提醒
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { AccountErr } from '../data/account-api.ts';
import type { SettingsErr } from '../data/settings-api.ts';
import { useSettingsT, type SettingsMsgKey } from '../hooks/useSettingsT.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import { accountErrText } from '../ui/AccountSection.tsx';
import { deviceErrKey } from '../ui/DevicesSection.tsx';

/** 假 t：原样回键名，看分到了哪一支 */
const keyOf = ((k: string) => k) as unknown as Parameters<typeof accountErrText>[1];

/** 两张表的值只能是实际用到的前缀（照 deviceErrKey 的 Extract 写法）：前缀写错，编译期就报 */
type AccountErrKey = Extract<SettingsMsgKey, `settings.err.${string}` | `settings.delete.${string}` | `settings.account.${string}`>;
type DeviceErrKey = Extract<SettingsMsgKey, `settings.err.${string}`>;

const ACCOUNT = {
  revoked: 'settings.err.unknown',
  signed_out: 'settings.err.unknown',
  account_disabled: 'settings.err.accountDisabled',
  pending_deletion: 'settings.err.unknown',
  offline: 'settings.err.offline',
  try_later: 'settings.err.tryLater',
  rate_limited: 'settings.account.rateLimited',
  confirm_required: 'settings.delete.confirmRequired',
  admin_cannot_delete: 'settings.delete.admin',
  unknown: 'settings.err.unknown',
} as const satisfies Record<AccountErr, AccountErrKey>;

const DEVICE = {
  revoked: 'settings.err.unknown',
  signed_out: 'settings.err.unknown',
  account_disabled: 'settings.err.accountDisabled',
  offline: 'settings.err.offline',
  try_later: 'settings.err.tryLater',
  is_current_device: 'settings.err.unknown',
  device_not_found: 'settings.err.unknown',
  unknown: 'settings.err.unknown',
} as const satisfies Record<SettingsErr, DeviceErrKey>;

describe('错误码 → 提示（R272-sugg ④）', () => {
  it('“服务器忙，稍后再试”：中文照用例原句，韩文是已审的那一句', () => {
    expect(zh['settings.err.tryLater']).toBe('服务器忙，稍后再试');
    expect(ko['settings.err.tryLater']).toBe('서버가 바빠요. 잠시 후 다시 시도해 주세요');
  });

  it.each(Object.entries(ACCOUNT))('导出、注销：%s → %s', (e, key) => {
    expect(accountErrText(e as AccountErr, keyOf)).toBe(key);
  });

  // 锁住 {word} 插值：用真的词典和 useSettingsT 渲染整句，句子里得有那个词（服务器只认“注销”“탈퇴”，R-188）
  it.each([
    ['zh-CN', zh],
    ['ko-KR', ko],
  ] as const)('confirm_required（%s）：整句里带上 settings.delete.word 那个词', (locale, dict) => {
    act(() => uiStore.getState().setLocale(locale));
    const { result } = renderHook(() => useSettingsT());
    const line = accountErrText('confirm_required', result.current);
    expect(line).toContain(dict['settings.delete.word']);
    expect(line).not.toContain('{word}');
    expect(line).toBe(dict['settings.delete.confirmRequired'].replace('{word}', dict['settings.delete.word']));
  });

  it.each(Object.entries(DEVICE))('设备列表：%s → %s', (e, key) => {
    expect(deviceErrKey(e as SettingsErr)).toBe(key);
  });
});

// 明早清单第 27 条（负责人 10-30）：退出时的提示说“可能要十几秒”，不说“最多”；韩文本来就是“걸릴 수도 있어요”（可能），不用“최대”
describe('退出登录提示的时长说法', () => {
  it('中文“可能要十几秒”、不含“最多”；韩文“10초 넘게 걸릴 수도 있어요”、不含“최대”', () => {
    expect(zh['settings.signingOut']).toContain('可能要十几秒');
    expect(zh['settings.signingOut']).not.toContain('最多');
    expect(ko['settings.signingOut']).toContain('10초 넘게 걸릴 수도 있어요');
    expect(ko['settings.signingOut']).not.toContain('최대');
  });
});
