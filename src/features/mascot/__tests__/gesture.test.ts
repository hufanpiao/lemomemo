// 吉祥物手势（hooks/gesture.ts）的短按、双击：有双击的角色（Aldo，负责人 11-26 选“点一下稍等再换形态”）短按要等 DOUBLE_MS 没有第二下才算，
// DOUBLE_MS 内再短按一下只走双击；没有双击的角色短按立刻算。jsdom 派发的事件 isTrusted 是 false，所以抓下 document 上的监听直接喂“真实”事件
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../motion/index.ts', () => ({ swallowNextClick: () => () => undefined }));
vi.mock('../../../motion/mascot-stage.ts', () => ({ perFrame: (f: (x: number, y: number) => void) => ({ call: f, cancel: () => undefined }) }));

const { DOUBLE_MS, LONG_MS, watchGesture } = await import('../hooks/gesture.ts');

type H = (e: unknown) => void;
let handlers: Map<string, H>;
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  handlers = new Map();
  spy = vi.spyOn(document, 'addEventListener').mockImplementation(((k: string, f: H) => handlers.set(k, f)) as never);
});
afterEach(() => {
  spy.mockRestore();
  vi.useRealTimers();
});

const ev = (x = 10, y = 10) => ({ isTrusted: true, isPrimary: true, button: 0, pointerId: 1, clientX: x, clientY: y, stopPropagation: () => undefined });
const tap = (): void => {
  handlers.get('pointerdown')?.(ev());
  handlers.get('pointerup')?.(ev());
};

const rig = (canDouble: boolean) => {
  const d = { hit: () => true, look: vi.fn(), tap: vi.fn(), long: vi.fn(), canDouble: () => canDouble, double: vi.fn() };
  const stop = watchGesture(d);
  return { d, stop };
};

describe('短按和双击（Aldo：点一下稍等再换形态）', () => {
  it('有双击：短按过 DOUBLE_MS 才算短按，之前不算', () => {
    const { d, stop } = rig(true);
    tap();
    vi.advanceTimersByTime(DOUBLE_MS - 1);
    expect(d.tap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(d.tap).toHaveBeenCalledTimes(1);
    expect(d.double).not.toHaveBeenCalled();
    stop();
  });

  it('有双击：DOUBLE_MS 内再点一下只走双击，不换形态', () => {
    const { d, stop } = rig(true);
    tap();
    vi.advanceTimersByTime(DOUBLE_MS - 10);
    tap();
    vi.advanceTimersByTime(DOUBLE_MS * 2);
    expect(d.double).toHaveBeenCalledTimes(1);
    expect(d.tap).not.toHaveBeenCalled();
    stop();
  });

  it('没有双击的角色：短按立刻算', () => {
    const { d, stop } = rig(false);
    tap();
    expect(d.tap).toHaveBeenCalledTimes(1);
    expect(d.double).not.toHaveBeenCalled();
    stop();
  });

  it('长按不算短按，也不排双击', () => {
    const { d, stop } = rig(true);
    handlers.get('pointerdown')?.(ev());
    vi.advanceTimersByTime(LONG_MS);
    handlers.get('pointerup')?.(ev());
    vi.advanceTimersByTime(DOUBLE_MS * 2);
    expect(d.long).toHaveBeenCalledTimes(1);
    expect(d.tap).not.toHaveBeenCalled();
    expect(d.double).not.toHaveBeenCalled();
    stop();
  });

  it('等第二下时卸载：不会再补一次短按', () => {
    const { d, stop } = rig(true);
    tap();
    stop();
    vi.advanceTimersByTime(DOUBLE_MS * 2);
    expect(d.tap).not.toHaveBeenCalled();
  });
});
