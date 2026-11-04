// 设备行按钮的读屏标签（KO-K43-a11y，B1 韩文审校 K-43）：整句走词典、不在代码里拼。
// 韩文按“对象 + 动作”语序、不带中文全角括号；中、韩都包含按钮上看得见的字（WCAG 2.5.3）。用真词典（SettingsPage.test 里韩文是替身）
import { describe, expect, it } from 'vitest';
import { createT } from '../../../../shared/i18n/i18n.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

const t = createT({ zh, ko });

describe('设备行读屏标签', () => {
  it('韩文：“{name}에서 로그아웃”“{name} 제거”（K-43 复核：unknown 本身是“알 수 없는 기기”，不再叠“기기”），没有全角括号，包含看得见的 로그아웃 / 제거', () => {
    const self = t('settings.devices.removeThisLabel', { name: 'iPhone' }, 'ko-KR');
    const other = t('settings.devices.removeLabel', { name: 'iPhone' }, 'ko-KR');
    expect(self).toBe('iPhone에서 로그아웃');
    expect(other).toBe('iPhone 제거');
    expect(`${self}${other}`).not.toMatch(/[（）]/);
    expect(self).toContain(ko['settings.devices.removeThis']);
    expect(other).toContain(ko['settings.devices.remove']);
  });

  it('中文读法和原来一样，包含看得见的字', () => {
    expect(t('settings.devices.removeThisLabel', { name: 'iPhone' }, 'zh-CN')).toBe(`${zh['settings.devices.removeThis']}（iPhone）`);
    expect(t('settings.devices.removeLabel', { name: 'iPhone' }, 'zh-CN')).toBe(`${zh['settings.devices.remove']} iPhone`);
  });
});
