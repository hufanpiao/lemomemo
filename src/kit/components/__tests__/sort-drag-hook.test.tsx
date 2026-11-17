// kit 长按拖动（SortDrag.tsx 的 useSortDrag + motion 的 useLongPressDrag；R-429 评审第 1、4、5、8 条）：
// • 触摸拿起也把指针抓到外框上；手指移到外框外面（底部自动滚动区压着输入行、底栏）松手照样放下，浮层收掉
// • 拖动中列表的动画实现到了：不换实现、整行不重挂（拿起时补发给左滑的那一下 pointercancel 不能让守卫以为手指抬起了）
// • 退场中的旧元素（list-impl 打 data-state="leaving"）还在外框里：拿起时不算它，落点照邻居算
// • 放下交邻居 id（beforeId / afterId），不交下标
// • 外框卸下（cancel unmount）：浮层、外框上的 data-sort-dragging 都收掉
// jsdom 不排版：行的位置按 data-top 给（getBoundingClientRect 打桩）。
// 动画实现下载到了就收不回（kit 测试只准引 motion 的三个出口，没有重置）：“实现到了”那一条放在最后
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearItem, AppearList } from '../../../motion/components.ts';
import { LIFT_MS } from '../../../motion/gestures.ts';
import { loadMotionFeatures } from '../../../motion/index.ts';
import { sortBoxClass, useSortDrag, type SortDrop } from '../SortDrag.tsx';

const realRect = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
    const t = this.dataset['top'];
    return t === undefined ? new DOMRect(0, 0, 300, 0) : new DOMRect(0, Number(t), 300, 50);
  };
  // jsdom 没有 PointerEvent：补一个最小的（long-press-drag 拿起时要补发 pointercancel）
  if (typeof window.PointerEvent !== 'function') {
    class PE extends MouseEvent {
      pointerId: number;
      pointerType: string;
      isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? '';
        this.isPrimary = init.isPrimary ?? false;
      }
    }
    vi.stubGlobal('PointerEvent', PE);
  }
});
afterEach(() => {
  cleanup();
  HTMLElement.prototype.getBoundingClientRect = realRect;
  vi.unstubAllGlobals();
  document.querySelectorAll('[data-testid="sort-float"]').forEach((f) => f.remove());
});

/** 门面换实现的守卫隔多久再看一次（motion/swap-guard.ts 的 SWAP_RETRY_MS 是 120） */
const SWAP_RETRY_MS = 120;
const wait = (ms: number) => act(() => new Promise<void>((ok) => setTimeout(ok, ms)));
const ptr = (el: Element, type: string, y: number, id = 5) =>
  act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: y }));
  });

function Page({ ids, onDrop, log, leaving = false }: { ids: string[]; onDrop: (d: SortDrop) => void; log: (l: string) => void; leaving?: boolean }) {
  // 音效和震动（R-471）记进同一串，好按先后断言
  const sd = useSortDrag({ tag: 't', axis: 'y', canDrop: () => true, onDrop, log, fx: (k) => log(`fx ${k}`) });
  return (
    <div ref={sd.ref} className={sortBoxClass} data-testid="box">
      <AppearList as="ul">
        {ids.map((id, i) => (
          <AppearItem key={id} data-sort-id={id} data-sort-group="all" data-top={String(i * 50)}>
            <span>{id}</span>
          </AppearItem>
        ))}
      </AppearList>
      {/* 退场中的旧元素（list-impl 的样子：打 data-state="leaving"，绝对定位压在原来的位置上） */}
      {leaving ? <div data-sort-id="x" data-sort-group="all" data-state="leaving" data-top="50" style={{ position: 'absolute' }} /> : null}
      {sd.line}
    </div>
  );
}

function setup(o: { ids?: string[]; leaving?: boolean } = {}) {
  const logs: string[] = [];
  const drops: SortDrop[] = [];
  const r = render(<Page ids={o.ids ?? ['a', 'b', 'c']} onDrop={(d) => drops.push(d)} log={(l) => logs.push(l)} leaving={o.leaving ?? false} />);
  const box = r.getByTestId('box');
  const cap = vi.fn();
  box.setPointerCapture = cap;
  const row = (id: string) => r.container.querySelector<HTMLElement>(`[data-sort-id="${id}"]:not([data-state="leaving"])`);
  return { ...r, box, cap, logs, drops, row };
}

/** 按住 c 那一行拿起来 */
async function lift(s: ReturnType<typeof setup>, id = 'c', y = 125) {
  const span = s.row(id)?.querySelector('span');
  if (!span) throw new Error('no row');
  await ptr(span, 'pointerdown', y);
  await wait(LIFT_MS + 60);
  expect(s.logs.some((l) => l.startsWith('sort t lift'))).toBe(true);
  return span;
}

describe('useSortDrag 手势（R-429 评审第 1 条）', () => {
  it('触摸拿起也把指针抓到外框上', async () => {
    const s = setup();
    await lift(s);
    expect(s.cap).toHaveBeenCalledWith(5);
  });

  it('手指移到外框外面松手：照样放下（交邻居 id）、浮层收掉、外框不再是拖动中', async () => {
    const s = setup();
    await lift(s);
    // 外框外面（例如压着底栏）：事件落在 body 上，不经过外框
    await ptr(document.body, 'pointermove', 52);
    await ptr(document.body, 'pointerup', 52);
    expect(s.drops).toEqual([{ id: 'c', from: 'all', to: 'all', beforeId: 'a', afterId: 'b' }]);
    // 拿起只震、放到新位置响一下震一下（R-471），各一次
    expect(s.logs.filter((l) => l.startsWith('fx '))).toEqual(['fx lift', 'fx drop']);
    // 浮层看不看得见（真机 11-17）：第一次挪动记一行 sort float（放下不量，会弄跳落位），带位置、computed 样式、中心最上面是谁；不记标题
    expect(s.logs.filter((l) => /^sort t float move r=-?\d+,-?\d+,\d+x\d+ vp=\d+x\d+ sy=\d+ css=\S+ on=body top=\S+ under=/.test(l))).toHaveLength(1);
    await wait(700);
    expect(document.querySelector('[data-testid="sort-float"]')).toBeNull();
    expect(s.box.hasAttribute('data-sort-dragging')).toBe(false);
  });

  it('拿起没挪就松手（落回原位）：只有拿起那一下震，放下不响（R-471）', async () => {
    const s = setup();
    const span = await lift(s);
    await ptr(span, 'pointerup', 125);
    expect(s.drops).toEqual([]);
    expect(s.logs.filter((l) => l.startsWith('fx '))).toEqual(['fx lift']);
    await wait(700);
  });
});

describe('退场中的元素（R-429 评审第 4、5 条）', () => {
  it('拿起时不算退场中的旧元素：条数、落点都照看得见的那几行', async () => {
    const s = setup({ leaving: true });
    await lift(s);
    expect(s.logs.some((l) => l.startsWith('sort t lift g=all n=3 us='))).toBe(true);
    await ptr(s.box, 'pointermove', 52);
    await ptr(s.box, 'pointerup', 52);
    expect(s.drops).toEqual([{ id: 'c', from: 'all', to: 'all', beforeId: 'a', afterId: 'b' }]);
  });
});

describe('卸下（R-429 评审第 8 条）', () => {
  it('拖着的时候外框卸下：浮层撤掉、外框上不留 data-sort-dragging', async () => {
    const s = setup();
    await lift(s);
    const box = s.box;
    expect(box.hasAttribute('data-sort-dragging')).toBe(true);
    s.unmount();
    expect(document.querySelector('[data-testid="sort-float"]')).toBeNull();
    expect(box.hasAttribute('data-sort-dragging')).toBe(false);
  });
});

describe('拖动中动画实现到了（R-429 评审第 1 条：整行为什么会重挂）', () => {
  it('拖动中动画实现到了：列表不换实现、整行不重挂；放下收完以后才换', async () => {
    const s = setup();
    const before = s.row('c');
    const span = await lift(s);
    await act(async () => {
      await loadMotionFeatures();
    });
    await wait(SWAP_RETRY_MS * 3);
    expect(s.row('c'), '拖动中整行不能被重新挂上').toBe(before);
    expect(s.row('c')?.hasAttribute('data-sort-lifted')).toBe(true);
    await ptr(span, 'pointerup', 125);
    await wait(700 + SWAP_RETRY_MS * 3);
    expect(s.row('c'), '收完以后照常换上实现').not.toBe(before);
    expect(s.row('c')?.hasAttribute('data-sort-lifted')).toBe(false);
  });
});
