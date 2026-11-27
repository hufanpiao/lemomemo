// 组件测试（TC-B1-32 后半、架构 9 组件测试）：链接只在 safeHref 通过时渲染成 <a>
// SAFE-link-real：测的是正式组件 kit/components/LocationText.tsx（整页提醒、日程编辑页共用）
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocationText } from '../LocationText.tsx';

describe('只在 safeHref 通过时渲染成 <a>', () => {
  afterEach(cleanup);

  const rejected = [
    'javascript:alert(1)',
    '  JaVaScRiPt:alert(1)  ',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '\x01javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/win.ini',
    // 安全审查 S4：没有协议的、带用户名密码的（看着像自家站，实际去 evil.com）
    '//evil.com',
    'https://user:pass@x/',
    'https://lemomemo.com@evil.com/',
  ];
  for (const text of rejected) {
    it(`不渲染链接：${JSON.stringify(text)}`, () => {
      const { container } = render(<LocationText text={text} />);
      expect(container.querySelector('a')).toBeNull();
      expect(container.querySelector('[href]')).toBeNull();
      expect(container.textContent).toBe(text);
    });
  }

  const allowed: readonly [string, string][] = [
    ['http://example.com/a', 'http://example.com/a'],
    ['https://lemomemo.com/app/', 'https://lemomemo.com/app/'],
    ['tel:+82-10-1234-5678', 'tel:+82-10-1234-5678'],
    ['mailto:someone@lemomemo.test', 'mailto:someone@lemomemo.test'],
  ];
  for (const [text, href] of allowed) {
    it(`渲染成链接：${text}`, () => {
      const { container } = render(<LocationText text={text} />);
      const a = container.querySelector('a');
      expect(a).not.toBeNull();
      expect(a?.getAttribute('href')).toBe(href);
      expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
      // mailto、tel 不带 target=_blank，交给顶层导航（B6-exe 安全审查 F5-5）；http、https 新窗口
      expect(a?.getAttribute('target')).toBe(/^https?:/.test(href) ? '_blank' : null);
      expect(a?.textContent).toBe(text);
    });
  }

  // 安全审查 S4：URL 解析会把开头的控制字符去掉、把 https:\ 当成 https://。放行时链接显示的是用户写的原文，href 是解析后的地址（看得出去哪）
  const normalized: readonly [string, string][] = [
    ['\x00https://x/', 'https://x/'],
    ['https:\\evil.com', 'https://evil.com/'],
  ];
  for (const [text, href] of normalized) {
    it(`解析后再放行：${JSON.stringify(text)} → ${href}`, () => {
      const { container } = render(<LocationText text={text} />);
      const a = container.querySelector('a');
      expect(a?.getAttribute('href')).toBe(href);
      expect(a?.textContent).toBe(text);
      expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    });
  }
});

// R-301（B6-exe 安全审查 F5-5）：exe 里用户亲手点了才交给系统浏览器（open_external），不靠 target=_blank、不靠页面跳转；网页版不拦
describe('点击链接', () => {
  const w = window as unknown as Record<string, unknown>;
  afterEach(() => {
    cleanup();
    delete w['__TAURI_INTERNALS__'];
  });

  it.each(['https://example.com/a', 'http://example.com/a', 'mailto:someone@lemomemo.test', 'tel:+82-10-1234-5678'])('exe：%s 点击时调 open_external、拦下默认行为', (text) => {
    const invoke = vi.fn(async () => undefined);
    w['__TAURI_INTERNALS__'] = { invoke };
    const { container } = render(<LocationText text={text} />);
    const a = container.querySelector('a');
    if (!a) throw new Error('没有链接');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(a, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('open_external', { url: a.getAttribute('href') });
  });

  it('exe：Rust 拒了、invoke 不在也拦下默认行为（宁可不打开，也不退回页面内导航）', () => {
    w['__TAURI_INTERNALS__'] = { invoke: vi.fn(() => Promise.reject(new Error('blocked'))) };
    const r1 = render(<LocationText text="https://example.com/" />);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(r1.container.querySelector('a') as HTMLAnchorElement, ev);
    expect(ev.defaultPrevented).toBe(true);
    cleanup();
    w['__TAURI_INTERNALS__'] = {};
    const r2 = render(<LocationText text="https://example.com/" />);
    const ev2 = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(r2.container.querySelector('a') as HTMLAnchorElement, ev2);
    expect(ev2.defaultPrevented).toBe(true);
  });

  it('网页：不拦（http、https 新窗口，mailto、tel 顶层导航）', () => {
    for (const text of ['https://example.com/', 'mailto:a@b.test']) {
      const { container } = render(<LocationText text={text} />);
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      fireEvent(container.querySelector('a') as HTMLAnchorElement, ev);
      expect(ev.defaultPrevented).toBe(false);
      cleanup();
    }
  });
});
