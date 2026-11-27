// kit 长按拖动（SortDrag.tsx 的 useSortDrag + motion 的 useLongPressDrag、liftFloat；R-461 整块重写，测试清单照重写方案 5.1）：
// • 拿起：浮层出现、原位是占位（data-sort-held）、html 上有 data-sort-dragging、已有选区清掉（日志 sel= 记清之前的长度）、指针抓到外框上
// • 预览顺序：越过上一项中线换位、越回来复原（页面按 sd.preview 画，DOM 顺序跟着变），每次换位记一行 sort t over
// • 放下：交邻居 id（beforeId / afterId）；手指在外框外面松手照样放下；浮层停稳后撤掉、占位显出来、html 标记去掉，日志 sort t settle
// • 取消（Esc）：预览顺序还原、不交 onDrop；卸下：浮层、html 标记马上收掉
// • 减少动态效果：浮层不倾斜、列表横向不跟
// • 退场中的旧元素（data-state="leaving"）不算；拖动中动画实现到了不换实现、整行不重挂
// jsdom 不排版：行的位置按 data-top 给（getBoundingClientRect、offsetTop / offsetParent 打桩）。
// 动画实现下载到了就收不回（kit 测试只准引 motion 的三个出口，没有重置）：“实现到了”那一条放在最后
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearItem, AppearList } from '../../../motion/components.ts';
import { LIFT_MS } from '../../../motion/gestures.ts';
import { loadMotionFeatures } from '../../../motion/index.ts';
import { SortBox, SortEnd, sortRowClass, useSortDrag, type SortDrop } from '../SortDrag.tsx';

const realRect = HTMLElement.prototype.getBoundingClientRect;
const props = ['offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight', 'offsetParent'] as const;
const realProps = props.map((p) => [p, Object.getOwnPropertyDescriptor(HTMLElement.prototype, p)] as const);
const num = (el: HTMLElement, k: string, d: number): number => (el.dataset[k] === undefined ? d : Number(el.dataset[k]));
beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
    return this.dataset['top'] === undefined ? new DOMRect(0, 0, 300, 0) : new DOMRect(num(this, 'left', 0), num(this, 'top', 0), num(this, 'w', 300), num(this, 'h', 50));
  };
  const def = (p: string, get: (this: HTMLElement) => unknown) => Object.defineProperty(HTMLElement.prototype, p, { configurable: true, get });
  def('offsetTop', function top() { return num(this, 'top', 0); });
  def('offsetLeft', function left() { return num(this, 'left', 0); });
  def('offsetWidth', function w() { return num(this, 'w', 300); });
  def('offsetHeight', function h() { return num(this, 'h', 50); });
  // 行的定位祖先就是外框（排版位置量到外框为止）
  def('offsetParent', function parent() { return this.dataset['sortId'] === undefined ? null : this.closest('[data-box]'); });
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
  // 没抬手就结束的用例（Esc、卸下）：换实现守卫记着的“按住的指针”清掉（它在切走窗口时清空），不拖累最后一条
  window.dispatchEvent(new Event('blur'));
  HTMLElement.prototype.getBoundingClientRect = realRect;
  for (const [p, d] of realProps) {
    if (d) Object.defineProperty(HTMLElement.prototype, p, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[p];
  }
  vi.unstubAllGlobals();
  document.querySelectorAll('[data-testid="sort-float"]').forEach((f) => f.remove());
  delete document.documentElement.dataset['rm'];
  delete document.documentElement.dataset['sortDragging'];
});

/** 门面换实现的守卫隔多久再看一次（motion/swap-guard.ts 的 SWAP_RETRY_MS 是 120） */
const SWAP_RETRY_MS = 120;
const wait = (ms: number) => act(() => new Promise<void>((ok) => setTimeout(ok, ms)));
/** 等浮层落下收掉（弹簧停稳且 --dur-ui 过完；jsdom 的帧在机器忙时很慢，按结果等不按时长等） */
const settled = () => vi.waitFor(() => expect(document.querySelector('[data-testid="sort-float"]')).toBeNull(), { timeout: 4000 });
const ptr = (el: Element, type: string, y: number, x = 100, id = 5) =>
  act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
  });

function Page({ ids, onDrop, log, leaving = false }: { ids: string[]; onDrop: (d: SortDrop) => void; log: (l: string) => void; leaving?: boolean }) {
  // 音效和震动（R-471）记进同一串，好按先后断言
  const sd = useSortDrag({ tag: 't', axis: 'y', onDrop, log, fx: (k) => log(`fx ${k}`) });
  return (
    <div data-testid="wrap">
      <SortBox sd={sd}>
        <AppearList as="ul">
          {sd.preview(ids, (x) => x).map((id, i) => (
            <AppearItem key={id} className={sortRowClass} {...sd.attrs(id, false)} data-top={String(i * 50)}>
              <span>{id}</span>
              <SortEnd>
                <button type="button">⋯</button>
              </SortEnd>
            </AppearItem>
          ))}
        </AppearList>
        {/* 退场中的旧元素（list-impl 的样子：打 data-state="leaving"，绝对定位压在原来的位置上） */}
        {leaving ? <div data-sort-id="x" data-state="leaving" data-top="50" style={{ position: 'absolute' }} /> : null}
      </SortBox>
    </div>
  );
}

function setup(o: { ids?: string[]; leaving?: boolean } = {}) {
  const logs: string[] = [];
  const drops: SortDrop[] = [];
  const ids = o.ids ?? ['a', 'b', 'c'];
  const r = render(<Page ids={ids} onDrop={(d) => drops.push(d)} log={(l) => logs.push(l)} leaving={o.leaving ?? false} />);
  const box = r.getByTestId('wrap').firstElementChild as HTMLElement;
  box.dataset['box'] = '';
  box.dataset['top'] = '0';
  box.dataset['h'] = String(ids.length * 50);
  const cap = vi.fn();
  box.setPointerCapture = cap;
  const row = (id: string) => r.container.querySelector<HTMLElement>(`[data-sort-id="${id}"]:not([data-state="leaving"])`);
  const order = () => [...r.container.querySelectorAll<HTMLElement>('[data-sort-id]:not([data-state="leaving"])')].map((e) => e.dataset['sortId']);
  const float = () => document.querySelector<HTMLElement>('[data-testid="sort-float"]');
  return { ...r, box, cap, logs, drops, row, order, float };
}

/** 按住 id 那一行拿起来（y：按下的位置） */
async function lift(s: ReturnType<typeof setup>, id = 'c', y = 125) {
  const span = s.row(id)?.querySelector('span');
  if (!span) throw new Error('no row');
  await ptr(span, 'pointerdown', y);
  await wait(LIFT_MS + 60);
  expect(s.logs.some((l) => l.startsWith('sort t lift'))).toBe(true);
  return span;
}

describe('拿起（R-461 2.1、2.6）', () => {
  it('浮层出现（带“⋯”和 6 个点那一格、拿起标记）、原位是占位、整页打拖动标记、指针抓到外框上', async () => {
    const s = setup();
    await lift(s);
    const f = s.float();
    expect(f).not.toBeNull();
    expect(f?.querySelector('[data-up]')).not.toBeNull();
    // 复制出来的那份去掉了 data-testid，按类名找
    expect(f?.querySelectorAll('[class*="grip"] i')).toHaveLength(6);
    expect(f?.querySelector('[data-sort-id]')).toBeNull();
    expect(s.row('c')?.hasAttribute('data-sort-held')).toBe(true);
    expect(s.row('a')?.hasAttribute('data-sort-held')).toBe(false);
    expect(document.documentElement.hasAttribute('data-sort-dragging')).toBe(true);
    expect(s.cap).toHaveBeenCalledWith(5);
    expect(s.logs.find((l) => l.startsWith('sort t lift'))).toMatch(/^sort t lift i=2 n=3 view=list sel=0 us=\S+$/);
  });

  it('拿起前已有选区：拿起时清掉，日志 sel= 记清之前的长度', async () => {
    const s = setup();
    const range = document.createRange();
    range.selectNodeContents(s.row('a')?.querySelector('span') as Node);
    window.getSelection()?.addRange(range);
    expect(window.getSelection()?.toString()).toBe('a');
    await lift(s);
    expect(window.getSelection()?.toString()).toBe('');
    expect(s.logs.some((l) => / lift .* sel=1 /.test(l))).toBe(true);
  });

  it('按下以后（还没拿起）就拦 selectstart；没拿起就松手不再拦', async () => {
    const s = setup();
    const span = s.row('a')?.querySelector('span') as Element;
    await ptr(span, 'pointerdown', 25);
    const ev = new Event('selectstart', { bubbles: true, cancelable: true });
    span.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await ptr(span, 'pointerup', 25);
    const ev2 = new Event('selectstart', { bubbles: true, cancelable: true });
    span.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
  });
});

describe('预览顺序（R-461 2.2）', () => {
  it('越过上一项中线换位（页面按预览顺序画）、越回来复原；每次换位一行 over', async () => {
    const s = setup();
    await lift(s);
    await ptr(s.box, 'pointermove', 80);
    expect(s.order()).toEqual(['a', 'b', 'c']);
    await ptr(s.box, 'pointermove', 68);
    expect(s.order()).toEqual(['a', 'c', 'b']);
    expect(s.row('c')?.hasAttribute('data-sort-held')).toBe(true);
    await ptr(s.box, 'pointermove', 128);
    expect(s.order()).toEqual(['a', 'b', 'c']);
    expect(s.logs.filter((l) => l.startsWith('sort t over'))).toEqual(['sort t over i=1', 'sort t over i=2']);
  });
});

describe('放下、取消、卸下（R-461 2.4、2.5）', () => {
  it('手指移到外框外面松手：照样放下（交邻居 id）；停稳后浮层撤掉、占位显出来、整页标记去掉', async () => {
    const s = setup();
    await lift(s);
    // 外框外面（例如压着底栏）：事件落在 body 上，不经过外框
    await ptr(document.body, 'pointermove', 52);
    await ptr(document.body, 'pointerup', 52);
    expect(s.drops).toEqual([{ id: 'c', beforeId: 'a', afterId: 'b' }]);
    expect(s.logs).toContain('sort t drop i=2 to=1 n=3');
    // 拿起只震、放到新位置响一下震一下（R-471），各一次
    expect(s.logs.filter((l) => l.startsWith('fx '))).toEqual(['fx lift', 'fx drop']);
    expect(s.float()?.querySelector('[data-up]')).toBeNull();
    await settled();
    expect(s.float()).toBeNull();
    expect(document.documentElement.hasAttribute('data-sort-dragging')).toBe(false);
    expect(s.row('c')?.hasAttribute('data-sort-held')).toBe(false);
    expect(s.logs.some((l) => /^sort t settle moved=1 ms=\d+ same=[01]$/.test(l))).toBe(true);
  });

  it('没挪动就松手：drop same，不交 onDrop', async () => {
    const s = setup();
    const span = await lift(s);
    await ptr(span, 'pointerup', 125);
    expect(s.drops).toEqual([]);
    expect(s.logs).toContain('sort t drop same');
    // 落回原位：只有拿起那一下震，放下不响（R-471）
    expect(s.logs.filter((l) => l.startsWith('fx '))).toEqual(['fx lift']);
    await settled();
    expect(s.float()).toBeNull();
  });

  it('Esc 取消：预览顺序还原、不交 onDrop，停稳后收掉', async () => {
    const s = setup();
    await lift(s);
    await ptr(s.box, 'pointermove', 20);
    expect(s.order()).toEqual(['c', 'a', 'b']);
    await act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(s.order()).toEqual(['a', 'b', 'c']);
    expect(s.logs).toContain('sort t cancel why=esc');
    await settled();
    expect(s.drops).toEqual([]);
    expect(s.logs.filter((l) => l.startsWith('fx '))).toEqual(['fx lift']);
    expect(s.float()).toBeNull();
    expect(document.documentElement.hasAttribute('data-sort-dragging')).toBe(false);
  });

  it('拖着的时候卸下：浮层、整页标记马上收掉', async () => {
    const s = setup();
    await lift(s);
    s.unmount();
    expect(s.float()).toBeNull();
    expect(document.documentElement.hasAttribute('data-sort-dragging')).toBe(false);
  });
});

describe('减少动态效果（R-461 2.3）', () => {
  it('浮层不倾斜、列表横向不跟', async () => {
    document.documentElement.dataset['rm'] = '1';
    const s = setup();
    await lift(s);
    await ptr(s.box, 'pointermove', 115, 160);
    await ptr(s.box, 'pointermove', 105, 220);
    await wait(60);
    const t = s.float()?.style.transform ?? '';
    expect(t).not.toContain('rotate');
    expect(t).toMatch(/^translate3d\(0\.00px, /);
  });

  it('平时：列表横向跟一点（最多 12px）', async () => {
    const s = setup();
    await lift(s);
    await ptr(s.box, 'pointermove', 120, 400);
    expect(s.float()?.style.transform).toMatch(/^translate3d\(12\.00px, /);
  });
});

describe('退场中的元素（R-429 评审第 4、5 条）', () => {
  it('拿起时不算退场中的旧元素：条数、落点都照看得见的那几行', async () => {
    const s = setup({ leaving: true });
    await lift(s);
    expect(s.logs.some((l) => l.startsWith('sort t lift i=2 n=3 '))).toBe(true);
    await ptr(s.box, 'pointermove', 52);
    await ptr(s.box, 'pointerup', 52);
    expect(s.drops).toEqual([{ id: 'c', beforeId: 'a', afterId: 'b' }]);
  });
});

describe('拖动中动画实现到了（R-429 评审第 1 条：整行为什么会重挂）', () => {
  it('拖动中动画实现到了：列表不换实现、整行不重挂；收完以后才换', async () => {
    const s = setup();
    const before = s.row('c');
    const span = await lift(s);
    await act(async () => {
      await loadMotionFeatures();
    });
    await wait(SWAP_RETRY_MS * 3);
    expect(s.row('c'), '拖动中整行不能被重新挂上').toBe(before);
    expect(s.row('c')?.hasAttribute('data-sort-held')).toBe(true);
    await ptr(span, 'pointerup', 125);
    await settled();
    await wait(SWAP_RETRY_MS * 3);
    expect(s.row('c'), '收完以后照常换上实现').not.toBe(before);
    expect(s.row('c')?.hasAttribute('data-sort-held')).toBe(false);
  });
});
