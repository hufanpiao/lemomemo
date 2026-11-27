// 设置 › 日历 的读写规则（B2 FA-3 第二段，R-97；cal.holidays、cal.week_start）
import { describe, expect, it } from 'vitest';
import { holidayChoice, KEY_HOLIDAYS, settingValue, settingWrite } from '../data/cal-settings.ts';

describe('settingValue', () => {
  it('取活着的那一行；被软删、被撤销的不算；没有就是 undefined', () => {
    expect(settingValue([{ id: 'a', key: KEY_HOLIDAYS, value: 'kr', deleted_at: null, undone: false }], KEY_HOLIDAYS)).toBe('kr');
    expect(settingValue([{ id: 'a', key: KEY_HOLIDAYS, value: 'kr', deleted_at: 5 }], KEY_HOLIDAYS)).toBeUndefined();
    expect(settingValue([{ id: 'a', key: KEY_HOLIDAYS, value: 'kr', undone: true }], KEY_HOLIDAYS)).toBeUndefined();
    expect(settingValue([{ id: 'a', key: 'ui.font', value: 'x' }], KEY_HOLIDAYS)).toBeUndefined();
  });
});

describe('settingWrite', () => {
  it('没有这一行：insert；值一样：不写；值不同：只 patch value', () => {
    expect(settingWrite([], KEY_HOLIDAYS, 'both')).toEqual({ op: 'insert', data: { key: KEY_HOLIDAYS, value: 'both' } });
    const rows = [{ id: 'a', key: KEY_HOLIDAYS, value: 'cn', deleted_at: null, undone: false }];
    expect(settingWrite(rows, KEY_HOLIDAYS, 'cn')).toBeNull();
    expect(settingWrite(rows, KEY_HOLIDAYS, 'kr')).toEqual({ op: 'patch', id: 'a', data: { value: 'kr' } });
  });

  it('那一行被软删或撤销过：patch 时顺带恢复（值一样也要写）', () => {
    expect(settingWrite([{ id: 'a', key: KEY_HOLIDAYS, value: 'cn', deleted_at: 9 }], KEY_HOLIDAYS, 'cn')).toEqual({ op: 'patch', id: 'a', data: { value: 'cn', deleted_at: null } });
    expect(settingWrite([{ id: 'a', key: KEY_HOLIDAYS, value: 'cn', undone: true }], KEY_HOLIDAYS, 'kr')).toEqual({ op: 'patch', id: 'a', data: { value: 'kr', undone: false } });
  });
});

describe('holidayChoice', () => {
  it('存过的有效值照用；没存过、不认识时跟界面语言（中文 cn、韩文 kr）', () => {
    expect(holidayChoice('both', 'zh-CN')).toBe('both');
    expect(holidayChoice(undefined, 'zh-CN')).toBe('cn');
    expect(holidayChoice(undefined, 'ko-KR')).toBe('kr');
    expect(holidayChoice('jp', 'ko-KR')).toBe('kr');
  });
});
