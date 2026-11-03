// 页面标题随界面语言（B1 韩文审校 K-16）：韩文“레모”、中文“柠檬记”，<html lang> 同步；脚本跑之前的静态 <title> 是 “Lemo”（R-310）
import { readFileSync } from 'node:fs';
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

describe('静态 <title>（R-310）', () => {
  it('主 App、登录页的 index.html 都写 “Lemo”；脚本跑了以后才按界面语言换', () => {
    for (const f of ['src/index.html', 'src/auth/index.html']) {
      const html = readFileSync(f, 'utf8');
      expect(html.match(/<title>([^<]*)<\/title>/)?.[1]).toBe('Lemo');
    }
  });
});
