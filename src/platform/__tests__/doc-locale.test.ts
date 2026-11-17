// 界面语言定下来、用上（platform/doc-locale.ts，两个入口和设置共用）：
// • applyUiLocale：ui-store、<html lang>、页面标题随界面语言（B1 韩文审校 K-16）：韩文“레모”、中文“柠檬记”；韩文整份词典没下载时标题照样“레모”（启动兜底）；
// • bootLocale：profiles.ui_locale → pv-locale → 设备语言 → 中文（16.4）；
// • 脚本跑之前的静态 <title> 是 “Lemo”（R-310）
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyUiLocale, bootLocale } from '../doc-locale.ts';

describe('applyUiLocale', () => {
  afterEach(() => {
    document.title = '';
    document.documentElement.lang = '';
  });

  it('韩文界面：标题“레모”（公共准备只放了中文，走启动兜底），lang 为 ko-KR，ui-store 跟着换', () => {
    const store = { setLocale: vi.fn() };
    applyUiLocale('ko-KR', store);
    expect(document.title).toBe('레모');
    expect(document.documentElement.lang).toBe('ko-KR');
    expect(store.setLocale).toHaveBeenCalledWith('ko-KR');
  });

  it('中文界面：标题“柠檬记”，切回来也跟着变', () => {
    const store = { setLocale: vi.fn() };
    applyUiLocale('ko-KR', store);
    applyUiLocale('zh-CN', store);
    expect(document.title).toBe('柠檬记');
    expect(document.documentElement.lang).toBe('zh-CN');
  });
});

describe('bootLocale', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  const langs = (l: string[]) => vi.spyOn(navigator, 'languages', 'get').mockReturnValue(l);

  it('缓存的 profiles.ui_locale 最先；不是两个精确值的当没有', () => {
    langs(['zh-CN']);
    localStorage.setItem('pv-locale', 'zh');
    expect(bootLocale('ko-KR')).toBe('ko-KR');
    expect(bootLocale('ko')).toBe('zh-CN');
    expect(bootLocale(42)).toBe('zh-CN');
  });

  it('没有 profile：本机选过的 pv-locale → 设备语言 → 中文', () => {
    langs(['ko-KR', 'en']);
    expect(bootLocale()).toBe('ko-KR');
    localStorage.setItem('pv-locale', 'zh');
    expect(bootLocale()).toBe('zh-CN');
    localStorage.clear();
    langs(['en-US']);
    expect(bootLocale(null)).toBe('zh-CN');
  });

  it('读不到 localStorage（隐私模式）：按设备语言', () => {
    langs(['ko']);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(bootLocale()).toBe('ko-KR');
  });
});

describe('静态 <title>（R-310）', () => {
  it('主 App、登录页的 index.html 都写 “Lemo”；脚本跑了以后才按界面语言换', () => {
    for (const f of ['src/index.html', 'src/auth/index.html']) {
      const html = readFileSync(f, 'utf8');
      expect(html.match(/<title>([^<]*)<\/title>/)?.[1]).toBe('Lemo');
    }
  });
});
