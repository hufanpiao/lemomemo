// shared/logic/link.ts（TC-B1-32；架构 5.9、9 单元测试）
import { describe, expect, it } from 'vitest';
import { safeHref } from '../../shared/logic/link.ts';

describe('safeHref', () => {
  // 用例前 8 个：一律拒绝
  const rejected: readonly [string, string][] = [
    ['javascript:alert(1)', 'javascript:alert(1)'],
    ['前后带空格、大小写混写', '  JaVaScRiPt:alert(1)  '],
    ['中间夹制表符', 'java\tscript:alert(1)'],
    ['中间夹换行', 'java\nscript:alert(1)'],
    ['开头带控制字符', '\x01javascript:alert(1)'],
    ['vbscript', 'vbscript:msgbox(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['file', 'file:///C:/Windows/win.ini'],
  ];
  for (const [name, input] of rejected) {
    it(`拒绝：${name}`, () => {
      expect(safeHref(input)).toBe(undefined);
    });
  }

  // 用例后 4 个：放行，返回解析后的 href
  const allowed: readonly [string, string][] = [
    ['http://example.com/a?b=1', 'http://example.com/a?b=1'],
    ['https://lemomemo.com/app/', 'https://lemomemo.com/app/'],
    ['tel:+82-10-1234-5678', 'tel:+82-10-1234-5678'],
    ['mailto:someone@lemomemo.test', 'mailto:someone@lemomemo.test'],
  ];
  for (const [input, href] of allowed) {
    it(`放行：${input}`, () => {
      expect(safeHref(input)).toBe(href);
    });
  }

  it('协议大小写和前后空格不影响放行，返回规整后的 href', () => {
    expect(safeHref('  HTTPS://Example.com  ')).toBe('https://example.com/');
  });

  // 审查补的反例：一律拒绝
  const moreRejected: readonly [string, string][] = [
    ['协议相对地址', '//evil.com'],
    ['反斜杠开头', '\\\\evil.com'],
    ['中间夹回车', 'java\rscript:alert(1)'],
    ['开头带 NUL', '\0javascript:alert(1)'],
    ['开头带零宽空格', '\u200Bjavascript:alert(1)'],
    ['全角字母', '\uFF4Aavascript:alert(1)'],
    ['用户名伪装成自家域名', 'https://lemomemo.com@evil.com/'],
    ['带用户名和密码', 'https://user:pass@example.com/'],
  ];
  for (const [name, input] of moreRejected) {
    it(`拒绝：${name}`, () => {
      expect(safeHref(input)).toBe(undefined);
    });
  }

  it('解析不了的（没有协议、空串）当普通文字', () => {
    expect(safeHref('www.example.com')).toBe(undefined);
    expect(safeHref('首尔站 3 号出口')).toBe(undefined);
    expect(safeHref('')).toBe(undefined);
  });
});
