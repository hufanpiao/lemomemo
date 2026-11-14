// 按住“＋”（GlassBarProps.add.hold，B3 FA-3）的守门（B3 任务单 Q3 守门第 5、6 条）：
// 5. 传不传 hold，底栏和“＋”的 HTML 逐字相同（不加节点、不改类名、不加 data-*），按下时 Pressable 的按下态也一样
// 6. 按住、挪动、松开期间 GlassBar 一次都不重新渲染（状态都在 features/plus 的闭包里）；点一下照常走 onClick，
//    进了录音以后松手补的那一下 click 不再打开打字条
// 首屏后部分（GlassBarFx）不挂：later 不调，只看 GlassBar 本身（Fx 的代点另有 kit 的 GlassBar-taps.test.tsx，hold 不碰它）
// 放在 plus 这边：要用 plus 的 createHoldInput，kit 不准引 feature
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlassBar } from '../../../kit/components/GlassBar/GlassBar.tsx';
import type * as UseT from '../../../kit/hooks/useT.ts';
import { swallowNextClick, TAP_SWALLOW_MS } from '../../../motion/index.ts';
import { createHoldInput, type HoldSink } from '../data/hold-input.ts';

/** 同 hooks/voice-sink.ts 注入的那一个 */
const swallow = (el: Node) => swallowNextClick({ within: el, ms: TAP_SWALLOW_MS.hold });
import { HOLD_MS } from '../data/record-logic.ts';

const renders = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../../kit/hooks/useT.ts', async (orig) => {
  const m = await orig<typeof UseT>();
  return {
    ...m,
    useT: () => {
      renders.n += 1;
      return m.useT();
    },
  };
});

const never = (): void => undefined;
/** 整段 HTML（逐字比） */
const html = (el: Element): string => new XMLSerializer().serializeToString(el);
const sleep = (ms: number) => act(() => new Promise<void>((ok) => setTimeout(ok, ms)));

function sink(): HoldSink & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    down: () => void calls.push('down'),
    start: () => {
      calls.push('start');
      return true;
    },
    zoneAt: () => null,
    zone: () => undefined,
    lock: () => undefined,
    finish: () => void calls.push('finish'),
    discard: () => void calls.push('discard'),
    idle: () => void calls.push('idle'),
  };
}

const ptr = { button: 0, isPrimary: true, pointerId: 1, clientX: 340, clientY: 800 };

afterEach(() => {
  cleanup();
});

describe('“＋”按住转发（Q3 守门第 5 条）', () => {
  it('传不传 hold：HTML 逐字相同', () => {
    const a = render(<GlassBar active="today" later={never} add={{ label: '新建', onClick: never }} />);
    const plain = html(a.container);
    cleanup();
    const h = createHoldInput(() => null, swallow);
    const b = render(<GlassBar active="today" later={never} add={{ label: '新建', onClick: never, hold: h }} />);
    expect(plain).toContain('tabbar-add');
    expect(html(b.container)).toBe(plain);
  });

  it('按下时：传不传 hold，按下态（data-state）一样', () => {
    const states: string[] = [];
    for (const hold of [undefined, createHoldInput(() => null, swallow)]) {
      render(<GlassBar active="today" later={never} add={{ label: '新建', onClick: never, ...(hold ? { hold } : {}) }} />);
      const fab = screen.getByTestId('tabbar-add');
      fireEvent.pointerDown(fab, ptr);
      states.push(`${fab.className}|${fab.getAttribute('data-state') ?? ''}`);
      fireEvent.pointerUp(fab, ptr);
      cleanup();
    }
    expect(states[0]).toBe(states[1]);
    expect(states[0]).toContain('|pressed');
  });
});

describe('按住期间 GlassBar 不重新渲染（Q3 守门第 6 条）', () => {
  it('按下、按满 350 ms、挪动、松开：GlassBar 渲染次数不变；补的 click 不打开打字条', async () => {
    const s = sink();
    const onClick = vi.fn();
    render(<GlassBar active="today" later={never} add={{ label: '新建', onClick, hold: createHoldInput(() => s, swallow) }} />);
    const fab = screen.getByTestId('tabbar-add');
    const before = renders.n;
    fireEvent.pointerDown(fab, ptr);
    await sleep(HOLD_MS + 50);
    fireEvent.pointerMove(fab, { ...ptr, clientY: 700 });
    fireEvent.pointerMove(fab, { ...ptr, clientY: 500 });
    fireEvent.pointerUp(fab, ptr);
    fireEvent.click(fab);
    expect(s.calls).toEqual(['down', 'start', 'finish']);
    expect(renders.n - before, 'GlassBar 没有因为按住重新渲染').toBe(0);
    expect(onClick, '进了录音以后松手补的 click 吞掉').not.toHaveBeenCalled();
  });

  it('点一下（不满 350 ms）：照常走 onClick 打开打字条，GlassBar 也不重新渲染', async () => {
    const s = sink();
    const onClick = vi.fn();
    render(<GlassBar active="today" later={never} add={{ label: '新建', onClick, hold: createHoldInput(() => s, swallow) }} />);
    const fab = screen.getByTestId('tabbar-add');
    const before = renders.n;
    fireEvent.pointerDown(fab, ptr);
    await sleep(50);
    fireEvent.pointerUp(fab, ptr);
    fireEvent.click(fab);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(s.calls).toEqual(['down', 'idle']);
    expect(renders.n - before).toBe(0);
  });
});
