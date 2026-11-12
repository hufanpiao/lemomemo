// 打字条后面的整页液态玻璃（R-399，11-12 负责人定中档 16px、点模糊处收起；ui/TypeBar.tsx 的 type-mist、ui/TypeBar.module.css 的 .mist）：
// 打字条画着这层就在，收起（记下后自动收起）或关掉就不在；出现、消失各记一行运行日志；点这层＝点页面空白处（没打字收起、打了字只收键盘）；
// 样式按源码文字核对（jsdom 不算布局、不画模糊）：层级令牌、模糊 16px、照底栏玻璃的着色和饱和度、减少透明和不支持时的后备、只淡入
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const ui = (n: number, w = writer(), onClose = vi.fn()) => <TypeBar day={null} writer={w} online={() => true} opened={n} onExpand={vi.fn()} onClose={onClose} />;
/** 一下点：按下、原地抬起（和 TypeBar-blank.test.tsx 同一个写法） */
const tap = (el: Element): void => {
  fireEvent.pointerDown(el, { clientX: 100, clientY: 100, isPrimary: true });
  fireEvent.pointerUp(el, { clientX: 100, clientY: 100, isPrimary: true });
};

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

  it('点这层、没打字：等同点“收起”，打字条和这层一起没了（11-12 负责人选“点模糊处收起打字条”）', async () => {
    const onClose = vi.fn();
    render(ui(1, writer(), onClose));
    tap(screen.getByTestId('type-mist'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('点这层、打了字：只收键盘，打字条、字和这层都留着（负责人 11-11“有字时保留输入框不动”）', () => {
    const onClose = vi.fn();
    render(ui(1, writer(), onClose));
    const input = screen.getByTestId('type-input');
    fireEvent.change(input, { target: { value: '买牛奶' } });
    input.focus();
    tap(screen.getByTestId('type-mist'));
    expect(document.activeElement).not.toBe(input);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('type-bar')).toBeTruthy();
    expect(screen.getByTestId('type-mist')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('买牛奶');
  });
});

describe('.mist 的样式（源码文字）', () => {
  const css = readFileSync('src/features/plus/ui/TypeBar.module.css', 'utf8');
  /** 第一次出现的 `selector {` 那一段 */
  const block = (selector: string, from = 0): string => {
    const at = css.indexOf(`${selector} {`, from);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };
  const prop = (b: string, name: string): string => (b.match(new RegExp(`(?:^|[\\s;{])${name}:\\s*([^;]+);`))?.[1] ?? '').trim();
  const mist = block('.mist');

  it('铺满可视区；层级用令牌 --z-mist：在底栏渐隐层、底栏、提示条、打字条下面，页面内容和顶部模糊带上面；接住点按（不写 pointer-events: none）', () => {
    expect(prop(mist, 'position')).toBe('fixed');
    expect(prop(mist, 'inset')).toBe('0 0 calc(0px - var(--vh-gap, 0px))');
    expect(prop(mist, 'z-index')).toBe('var(--z-mist)');
    const base = readFileSync('src/styles/base.css', 'utf8');
    const z = (name: string): number => Number(base.match(new RegExp(String.raw`--z-${name}:\s*(\d+);`))?.[1]);
    expect(z('mist')).toBeGreaterThan(z('strip'));
    expect(z('mist')).toBeLessThan(z('bar-fx'));
    expect(z('mist')).toBeLessThan(z('toast'));
    expect(z('mist')).toBeLessThan(z('float'));
    expect(prop(block('.saved'), 'z-index')).toBe('var(--z-toast)');
    expect(prop(block('.bar'), 'z-index')).toBe('var(--z-float)');
    expect(prop(mist, 'pointer-events')).toBe('');
  });

  it('材质照底栏的液态玻璃：模糊 16px（中档）、饱和度 1.8、着色 --g-tint、高光 --g-hi 乘 --g-sheen', () => {
    expect(prop(mist, 'backdrop-filter')).toBe('blur(16px) saturate(1.8)');
    expect(prop(mist, 'background')).toBe('var(--g-tint)');
    const sheen = block('.mist::after');
    expect(prop(sheen, 'background')).toBe('radial-gradient(120% 90% at 22% -30%, var(--g-hi) 0 38%, transparent 60%)');
    expect(prop(sheen, 'opacity')).toBe('var(--g-sheen)');
    // 和底栏玻璃同一个写法（kit GlassBar.module.css 的 .glass::after、.bar 的饱和度）
    const bar = readFileSync('src/kit/components/GlassBar/GlassBar.module.css', 'utf8');
    expect(bar).toContain(`background: ${prop(sheen, 'background')};`);
    expect(bar).toContain('saturate(1.8)');
  });

  it('出现只淡入 110ms ease-out，不动位置（整份样式里这层不写 transform、translate、scale）', () => {
    expect(prop(mist, 'animation')).toBe('mist-in calc(var(--dur-ui) / 2) var(--ease-out) both');
    const frames = css.slice(css.indexOf('@keyframes mist-in'), css.indexOf('/* 减少透明效果'));
    expect(frames.replace(/\s+/g, ' ')).toContain('from { opacity: 0; } to { opacity: 1; }');
    expect(frames).not.toMatch(/transform|translate|scale/);
    expect(mist).not.toMatch(/transform|translate|scale/);
  });

  it('减少透明效果（系统设置、data-rt）和不认 backdrop-filter 时：不模糊、不画高光，退成半透明纯色 --g-tint-fb', () => {
    const media = css.slice(css.indexOf('@media (prefers-reduced-transparency: reduce) {\n  .mist {'));
    expect(media.startsWith('@media')).toBe(true);
    const inMedia = media.slice(0, media.indexOf('\n}\n'));
    expect(inMedia).toMatch(/\.mist \{\s*background: var\(--g-tint-fb\);\s*backdrop-filter: none;\s*\}/);
    expect(inMedia).toMatch(/\.mist::after \{\s*display: none;\s*\}/);
    const rt = block(":global(:root[data-rt='1']) .mist");
    expect(prop(rt, 'background')).toBe('var(--g-tint-fb)');
    expect(prop(rt, 'backdrop-filter')).toBe('none');
    expect(prop(block(":global(:root[data-rt='1']) .mist::after"), 'display')).toBe('none');
    // 旧一些的 iOS 只认带前缀的写法：两种都不认才算不支持
    const sup = css.slice(css.indexOf('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {'));
    expect(sup.startsWith('@supports')).toBe(true);
    const inSup = sup.slice(0, sup.indexOf('\n}\n'));
    expect(inSup).toMatch(/\.mist \{\s*background: var\(--g-tint-fb\);\s*\}/);
    expect(inSup).toMatch(/\.mist::after \{\s*display: none;\s*\}/);
  });
});
