// 网页版 AI 栏标题前的小号吉祥物（光球 #7）：放哪一只、不跳下落、状态写在 data-state、只给读屏藏起来、卸载销毁、日志只记 id 和状态
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MASCOTS } from '../hooks/mascot-data.ts';
import MascotMini from '../ui/MascotMini.tsx';
import { stageId } from './stage-id.ts';

const h = vi.hoisted(() => ({
  live: 0,
  logs: [] as string[],
  calls: [] as { id: string; url: string; cb: { onReady?(): void; onFail?(): void; noDrop?: boolean } }[],
}));

vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: (m: string) => h.logs.push(m) }));
vi.mock('../hooks/stage.ts', () => ({
  createStage: (_el: HTMLElement, def: { url: string }, cb: { onReady?(): void; onFail?(): void; noDrop?: boolean }) => {
    h.live += 1;
    h.calls.push({ id: stageId(def), url: def.url, cb });
    return { destroy: () => (h.live -= 1) };
  },
}));

const box = (c: HTMLElement): HTMLElement => c.querySelector('[data-mascot-mini]') as HTMLElement;

beforeEach(() => {
  h.live = 0;
  h.logs = [];
  h.calls = [];
});
afterEach(cleanup);

describe('小号吉祥物', () => {
  it('放光球：用目录里 #7 的素材，不做掉落回弹；盒子带调用方的类名、读屏看不到', () => {
    const { container } = render(<MascotMini id="7" className="dockOrb" />);
    expect(h.calls.map((c) => [c.id, c.url, c.cb.noDrop])).toEqual([['7', MASCOTS['7'].url, true]]);
    const el = box(container);
    expect(el.className).toBe('dockOrb');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.dataset['mascotMini']).toBe('7');
    expect(el.dataset['state']).toBe('wait');
  });

  it('载好写 ready、下不来写 fail（调用方据此退回小脸），不抛', () => {
    const { container } = render(<MascotMini id="7" className="x" />);
    act(() => h.calls[0]?.cb.onReady?.());
    expect(box(container).dataset['state']).toBe('ready');
    act(() => h.calls[0]?.cb.onFail?.());
    expect(box(container).dataset['state']).toBe('fail');
    expect(h.logs).toEqual(['mascot mini load id=7', 'mascot mini ready id=7', 'mascot mini fail id=7']);
  });

  it('卸载后一个实例不剩', () => {
    const { unmount } = render(<MascotMini id="7" className="x" />);
    expect(h.live).toBe(1);
    unmount();
    expect(h.live).toBe(0);
  });
});
