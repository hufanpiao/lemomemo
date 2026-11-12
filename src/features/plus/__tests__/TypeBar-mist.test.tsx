// 打字条后面的整页液态玻璃（R-399，11-12 负责人定中档 16px、点模糊处收起；ui/TypeBar.tsx 的 type-mist、ui/TypeBar.module.css 的 .mist）：
// 打字条画着这层就在，收起（记下后自动收起）或关掉就不在；出现、消失各记一行运行日志；
// 点这层的行为在 TypeBar-blank.test.tsx；样式只核真浏览器模拟不了的（层级令牌的高低、减少透明和不支持时的后备），实际模糊和点按在 e2e r399-mist.spec.ts
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import type { WriteResult } from '../../../core/write.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import type { Writer } from '../data/capture-save.ts';
import TypeBar from '../ui/TypeBar.tsx';
import type * as Session from '../../../platform/session.ts';

const SID = 'sid-t';
vi.mock('../../../platform/session.ts', async (orig) => ({ ...(await orig<typeof Session>()), readSessionId: () => SID }));

const NOW = msAt('2026-11-02', 12 * 60, 'UTC');
const OK: WriteResult = { ok: true, item: null };
const slots = globalThis as unknown as Record<string, unknown>;
let lines: string[] = [];
const mistLines = (): string[] => lines.filter((l) => l.startsWith('typebar mist'));

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  uiStore.getState().setLocale('zh-CN');
  lines = [];
  slots[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete slots[RL_SLOT];
});

const writer = () => ({ insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) });
const ui = (n: number, w = writer()) => <TypeBar day={null} writer={w} online={() => true} opened={n} onExpand={vi.fn()} onClose={vi.fn()} />;

describe('打字条后面的整页玻璃层（R-399）', () => {
  it('打字条打开：这层在，不进读屏，排在打字条前面；记一行 on', () => {
    render(ui(1));
    const mist = screen.getByTestId('type-mist');
    expect(mist.getAttribute('aria-hidden')).toBe('true');
    expect(mist.childElementCount).toBe(0);
    expect(mist.nextElementSibling).toBe(screen.getByTestId('type-bar'));
    expect(mistLines()).toEqual(['typebar mist on fx=none']);
  });

  it('记下后打字条自动收起（只留提示条）：这层不在，记一行 off；再点“＋”（opened 变了）这层回来，再记 on', async () => {
    const w = writer();
    const r = render(ui(1, w));
    fireEvent.change(screen.getByTestId('type-input'), { target: { value: '明天下午3点去银行办理业务' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
    expect(screen.getByTestId('type-notice')).toBeTruthy();
    expect(screen.queryByTestId('type-bar')).toBeNull();
    expect(screen.queryByTestId('type-mist')).toBeNull();
    expect(mistLines()).toEqual(['typebar mist on fx=none', 'typebar mist off']);
    act(() => r.rerender(ui(2, w)));
    expect(screen.getByTestId('type-mist')).toBeTruthy();
    expect(mistLines()).toEqual(['typebar mist on fx=none', 'typebar mist off', 'typebar mist on fx=none']);
  });

  it('打字条关掉（卸载）：这层不在，记一行 off', () => {
    const r = render(ui(1));
    r.unmount();
    expect(screen.queryByTestId('type-mist')).toBeNull();
    expect(mistLines()).toEqual(['typebar mist on fx=none', 'typebar mist off']);
  });

});

describe('.mist 的样式（源码文字：只核真浏览器里模拟不了的；实际生效的模糊、层级、点按在 e2e r399-mist.spec.ts）', () => {
  const css = readFileSync('src/features/plus/ui/TypeBar.module.css', 'utf8');
  const base = readFileSync('src/styles/base.css', 'utf8');
  const z = (name: string): number => Number(base.match(new RegExp(String.raw`--z-${name}:\s*(\d+);`))?.[1]);

  it('层级用令牌 --z-mist：在顶部模糊带上面，在底栏渐隐层、提示条、打字条下面', () => {
    expect(css).toMatch(/\.mist \{[^}]*z-index: var\(--z-mist\);/);
    expect(z('mist')).toBeGreaterThan(z('strip'));
    for (const above of ['bar-fx', 'bar', 'toast', 'float']) expect(z('mist')).toBeLessThan(z(above));
  });

  it('减少透明效果（系统设置、data-rt）和不认 backdrop-filter（两种写法都不认）：不模糊、不画高光，退成半透明纯色 --g-tint-fb', () => {
    const fallback = String.raw`\.mist \{\s*background: var\(--g-tint-fb\);`;
    expect(css).toMatch(new RegExp(String.raw`@media \(prefers-reduced-transparency: reduce\) \{\s*${fallback}\s*backdrop-filter: none;\s*\}\s*\.mist::after \{\s*display: none;`));
    expect(css).toMatch(new RegExp(String.raw`:global\(:root\[data-rt='1'\]\) ${fallback}\s*backdrop-filter: none;`));
    expect(css).toMatch(/:global\(:root\[data-rt='1'\]\) \.mist::after \{\s*display: none;/);
    expect(css).toMatch(new RegExp(String.raw`@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\) \{\s*${fallback}\s*\}\s*\.mist::after \{\s*display: none;`));
  });
});
