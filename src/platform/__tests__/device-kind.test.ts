// 按设备类型分开记的设置（B4 S1，R-78；core/setting-read.ts）：哪台算手机、哪台算电脑；键加 @mobile / @desktop
import { describe, expect, it } from 'vitest';
import { deviceKindOf, perDeviceKey } from '../device-kind.ts';

describe('deviceKindOf', () => {
  it('电脑版 exe 算电脑（哪怕是触屏笔记本）；iPhone / iPad 算手机；其余粗指针（触屏）算手机，鼠标、触控板算电脑', () => {
    expect(deviceKindOf({ tauri: true, appleMobile: false, coarse: true })).toBe('desktop');
    expect(deviceKindOf({ tauri: false, appleMobile: true, coarse: false })).toBe('mobile');
    expect(deviceKindOf({ tauri: false, appleMobile: false, coarse: true })).toBe('mobile');
    expect(deviceKindOf({ tauri: false, appleMobile: false, coarse: false })).toBe('desktop');
  });

  it('键名照数据字典第 838 行：notes.view@mobile、notes.view@desktop', () => {
    expect(perDeviceKey('notes.view', 'mobile')).toBe('notes.view@mobile');
    expect(perDeviceKey('notes.view', 'desktop')).toBe('notes.view@desktop');
  });
});
