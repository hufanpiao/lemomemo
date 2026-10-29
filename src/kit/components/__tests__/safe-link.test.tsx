// 组件测试（TC-B1-32 后半、架构 9 组件测试）：链接只在 safeHref 通过时渲染成 <a>
// 地点链接的正式组件还没做（整页提醒、编辑栏），这里用一个最小组件按架构 5.9 的写法验证
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { safeHref } from '../../../../shared/logic/link.ts';

/** 地点文字：能过 safeHref 的渲染成链接（加 noopener noreferrer），否则当普通文字 */
function LocationText({ text }: { text: string }) {
  if (safeHref(text) === undefined) return <span>{text}</span>;
  return (
    <a href={safeHref(text)} rel="noopener noreferrer">
      {text}
    </a>
  );
}

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
      expect(a?.textContent).toBe(text);
    });
  }
});
