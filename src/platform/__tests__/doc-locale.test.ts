// 页面标题随界面语言（B1 韩文审校 K-16）：韩文“레모”、中文“柠檬记”，<html lang> 同步
import { afterEach, describe, expect, it } from 'vitest';
import { applyDocLocale } from '../doc-locale.ts';

describe('applyDocLocale', () => {
  afterEach(() => {
    document.title = '';
    document.documentElement.lang = '';
  });

  it('韩文界面：标题“레모”，lang 为 ko-KR', () => {
    applyDocLocale('ko-KR');
    expect(document.title).toBe('레모');
    expect(document.documentElement.lang).toBe('ko-KR');
  });

  it('中文界面：标题“柠檬记”，切回来也跟着变', () => {
    applyDocLocale('ko-KR');
    applyDocLocale('zh-CN');
    expect(document.title).toBe('柠檬记');
    expect(document.documentElement.lang).toBe('zh-CN');
  });
});
