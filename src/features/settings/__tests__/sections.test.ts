// 设置页分组顺序表（data/sections.ts；R-256 ①；TC-B1-71）：顺序只看表，不看登记先后
import { describe, expect, it } from 'vitest';
import { orderSections, SETTINGS_SECTION_ORDER } from '../data/sections.ts';

describe('分组顺序表', () => {
  it('账号第一、界面语言第二；数据在时区之后、Claude 之前；关于最后；不重复', () => {
    expect(SETTINGS_SECTION_ORDER[0]).toBe('account');
    expect(SETTINGS_SECTION_ORDER[1]).toBe('language');
    const at = (id: (typeof SETTINGS_SECTION_ORDER)[number]): number => SETTINGS_SECTION_ORDER.indexOf(id);
    expect(at('timezone')).toBeLessThan(at('data'));
    expect(at('data')).toBeLessThan(at('claude'));
    expect(SETTINGS_SECTION_ORDER[SETTINGS_SECTION_ORDER.length - 1]).toBe('about');
    expect(new Set(SETTINGS_SECTION_ORDER).size).toBe(SETTINGS_SECTION_ORDER.length);
  });

  it('orderSections 按表排，和给的先后无关；没给的跳过', () => {
    expect(orderSections({ data: 'D', about: 'Z', language: 'L', account: 'A' }).map(([id]) => id)).toEqual(['account', 'language', 'data', 'about']);
    expect(orderSections({})).toEqual([]);
  });
});
