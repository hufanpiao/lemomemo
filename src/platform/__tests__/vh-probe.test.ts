// 可见高度真机探测（platform/vh-probe.ts，R-371 第二条路）：每种办法做完都能原样撤回；结果一行里有前、做着时、撤回后、过一会儿四组数
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATER_MS, runVhMethod, VH_METHODS, vhSnap, WAIT_MS } from '../vh-probe.ts';

const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover';
const method = (id: string) => {
  const m = VH_METHODS.find((x) => x.id === id);
  if (!m) throw new Error(id);
  return m;
};

beforeEach(() => {
  const meta = document.createElement('meta');
  meta.name = 'viewport';
  meta.content = VIEWPORT;
  document.head.append(meta);
});
afterEach(() => {
  document.head.querySelector('meta[name="viewport"]')?.remove();
  document.documentElement.removeAttribute('style');
  vi.restoreAllMocks();
});

describe('VH_METHODS', () => {
  it('至少五种：meta 加 height、scrollTo 0、html 100vh、滚 1px、meta 去 viewport-fit', () => {
    expect(VH_METHODS.map((m) => m.id)).toEqual(['meta-height', 'scroll-top', 'html-100vh', 'scroll-1px', 'meta-fit']);
  });

  it('① 做着时 viewport 带 height=device-height，撤回后原样', () => {
    const undo = method('meta-height').apply(window);
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe(`${VIEWPORT}, height=device-height`);
    undo();
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe(VIEWPORT);
  });

  it('⑤ 做着时去掉 viewport-fit=cover，撤回后原样', () => {
    const undo = method('meta-fit').apply(window);
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe('width=device-width, initial-scale=1');
    undo();
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe(VIEWPORT);
  });

  it('③ html 高度 100vh，撤回后去掉；原来有值就写回原值', () => {
    const st = document.documentElement.style;
    let undo = method('html-100vh').apply(window);
    expect(st.getPropertyValue('height')).toBe('100vh');
    undo();
    expect(st.getPropertyValue('height')).toBe('');
    st.setProperty('height', '50px');
    undo = method('html-100vh').apply(window);
    undo();
    expect(st.getPropertyValue('height')).toBe('50px');
  });

  it('② 滚到 0、撤回时滚回原处；④ 滚 1px 加最小高度，撤回时滚回去、去掉最小高度', () => {
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(120);
    const to = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    method('scroll-top').apply(window)();
    expect(to.mock.calls).toEqual([[0, 0], [0, 120]]);
    to.mockClear();
    const undo = method('scroll-1px').apply(window);
    expect(document.documentElement.style.getPropertyValue('min-height')).toContain('100vh');
    undo();
    expect(to.mock.calls).toEqual([[0, 121], [0, 120]]);
    expect(document.documentElement.style.getPropertyValue('min-height')).toBe('');
  });
});

describe('runVhMethod', () => {
  it('一行里有 before、doing、undone、+1s 四组 inner/screen/vv/client；等的是 WAIT_MS、WAIT_MS、LATER_MS', async () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(894);
    vi.spyOn(window.screen, 'height', 'get').mockReturnValue(956);
    const waits: number[] = [];
    const line = await runVhMethod(method('meta-height'), window, (ms) => {
      waits.push(ms);
      return Promise.resolve();
    });
    expect(waits).toEqual([WAIT_MS, WAIT_MS, LATER_MS]);
    expect(line).toMatch(/^vh meta-height: \| before inner=894 screen=956 vv=\S+ client=\d+ y=\d+ \| doing inner=894 .* \| undone inner=894 .* \| \+1s inner=894 /);
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe(VIEWPORT);
  });

  it('做的时候出错：照样撤回、记下 apply-err，不抛', async () => {
    const line = await runVhMethod({ id: 'bad', label: 'x', apply: () => { throw new Error('boom'); } }, window, () => Promise.resolve());
    expect(line).toContain('apply-err=Error: boom');
  });

  it('vhSnap 读 innerHeight、screen.height、visualViewport.height', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(894);
    vi.spyOn(window.screen, 'height', 'get').mockReturnValue(956);
    expect(vhSnap()).toMatchObject({ inner: 894, screen: 956 });
  });
});
