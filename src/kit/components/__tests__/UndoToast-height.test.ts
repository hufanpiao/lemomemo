// 撤销条的高度和 base.css 的 --undo-h 一致（K8 冲突提示方案 3.1：提示卡在撤销条开着时往上让 --undo-h + 8px）。
// jsdom 不排版，这里按样式算：上下内边距 + 撤销按钮的最小高度（--hit）；e2e（b2-sync-notice.spec.ts）再量一次真实高度
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const px = (css: string, re: RegExp): number => {
  const m = re.exec(css);
  if (!m?.[1]) throw new Error(`没找到 ${re}`);
  return Number(m[1]);
};

describe('--undo-h', () => {
  it('等于撤销条的内边距上下加按钮最小高度（44px 点击区）', () => {
    const toast = read('src/kit/components/UndoToast.module.css');
    const base = read('src/styles/base.css');
    const tokens = `${read('src/styles/tokens.css')}\n${base}`;
    const block = /\.toast\s*\{([^}]*)\}/.exec(toast)?.[1] ?? '';
    const [top, , bottom] = (/padding:\s*([0-9px\s]+);/.exec(block)?.[1] ?? '').trim().split(/\s+/).map((v) => Number.parseFloat(v));
    const undoBlock = /\.undo\s*\{([^}]*)\}/.exec(toast)?.[1] ?? '';
    expect(undoBlock).toContain('min-height: var(--hit)');
    const hit = px(tokens, /--hit:\s*(\d+)px/);
    const undoH = px(base, /--undo-h:\s*(\d+)px/);
    expect(top).toBeGreaterThan(0);
    expect((top ?? 0) + hit + (bottom ?? 0)).toBe(undoH);
  });
});
