// 层栈（kit/hooks/layers.ts；第三方审查前端-8、14）：所有弹层挂上入栈、卸下出栈——
// • Esc 只关栈顶那一层；两层叠着按一次只关上面一层
// • 栈顶是模态层时，它下面的内容（页面、下面那一层）inert；关掉以后撤掉
// • 关掉以后焦点回到打开它的按钮（上层关了回到下层里的按钮）
// • 不同写法的层混着叠（左滑露出的行 + 弹层）也一样：Esc 只收上面那个
// • 11-14 层栈整块评审：非模态层在栈顶而焦点在别处时 Esc 先给焦点所在的元素；焦点在非模态层里时页面的键不生效；Shift 编进键名；组字判断一处
//   （跳页、下层先关、StrictMode、inert 被改、热替换几种情形在 layers-review.test.tsx）
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../../components/Dialog.tsx';
import { SwipeRow } from '../../components/SwipeRow.tsx';
import { keyName, resetLayers, useKeys, type LayerHandle } from '../layers.ts';
import { useLayer } from '../useLayer.ts';

const lines: string[] = [];
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: (l: string) => lines.push(l) }));

afterEach(() => {
  lines.length = 0;
  cleanup();
  resetLayers();
  document.body.replaceChildren();
});

function Two() {
  const [a, setA] = useState(false);
  const [b, setB] = useState(false);
  return (
    <div data-testid="page">
      <button type="button" data-testid="open-a" onClick={() => setA(true)}>
        A
      </button>
      <Dialog open={a} onOpenChange={setA} title="A">
        <button type="button" data-testid="open-b" onClick={() => setB(true)}>
          B
        </button>
      </Dialog>
      <Dialog open={b} onOpenChange={setB} title="B">
        <button type="button" data-testid="in-b">
          b
        </button>
      </Dialog>
    </div>
  );
}

const dialogOf = (title: string): HTMLElement => screen.getByRole('dialog', { name: title });
/** 元素自己或它的某个祖先带 inert */
const inInert = (el: Element): boolean => el.closest('[inert]') !== null;

describe('层栈：两层弹层叠着', () => {
  it('按一次 Esc 只关上面一层；关掉以后焦点回到下层里打开它的按钮；上层开着时下层和页面 inert，关了撤掉', async () => {
    const user = userEvent.setup();
    render(<Two />);
    const openA = screen.getByTestId('open-a');
    openA.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(dialogOf('A').contains(document.activeElement)).toBe(true));
    const openB = screen.getByTestId('open-b');
    openB.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(dialogOf('B').contains(document.activeElement)).toBe(true));

    // 上层开着：下层的按钮、页面的按钮都在 inert 里；上层自己不在
    expect(inInert(openB), '下层 inert').toBe(true);
    expect(inInert(openA), '页面 inert').toBe(true);
    expect(inInert(screen.getByTestId('in-b')), '栈顶自己不 inert').toBe(false);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'B' })).toBeNull(), { timeout: 3000 });
    expect(screen.getByRole('dialog', { name: 'A' }), '下层还开着').toBeTruthy();
    expect(document.activeElement, '焦点回到下层里打开 B 的按钮').toBe(openB);
    expect(inInert(openB), '下层成了栈顶，不再 inert').toBe(false);
    expect(inInert(openA), '页面仍在下层下面，仍 inert').toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 3000 });
    expect(document.activeElement).toBe(openA);
    expect(inInert(openA)).toBe(false);
  });
});

describe('层栈：不同写法的层混着叠', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(144);
    HTMLElement.prototype.setPointerCapture = () => undefined;
  });

  function RowAndDialog() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <SwipeRow data-testid="row" log={() => undefined} actions={[{ key: 'del', label: '删除', danger: true, onClick: () => undefined, testId: 'row-del' }]}>
          <button type="button" data-testid="row-main">
            行
          </button>
        </SwipeRow>
        <button type="button" data-testid="other" onClick={() => setOpen(true)}>
          别处
        </button>
        <Dialog open={open} onOpenChange={setOpen} title="确认">
          <button type="button">好</button>
        </Dialog>
      </>
    );
  }

  it('左滑露出一行，再用键盘在别处开了弹层：Esc 只关弹层，行还露着、焦点回到那个按钮；再按一次才收起行', async () => {
    const user = userEvent.setup();
    render(<RowAndDialog />);
    const face = screen.getByTestId('row-main').parentElement as HTMLElement;
    const pd = (x: number) => ({ pointerId: 1, isPrimary: true, clientX: x, clientY: 20, button: 0, pointerType: 'touch' });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.pointerDown(face, pd(200));
    fireEvent.pointerMove(face, pd(150));
    fireEvent.pointerMove(face, pd(100));
    fireEvent.pointerUp(face, pd(100));
    expect(screen.getByTestId('row').getAttribute('data-swipe')).toBe('open');
    const other = screen.getByTestId('other');
    other.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 3000 });
    expect(screen.getByTestId('row').getAttribute('data-swipe'), '行还露着').toBe('open');
    expect(document.activeElement).toBe(other);
    await act(async () => {
      await user.keyboard('{Escape}');
    });
    expect(screen.getByTestId('row').getAttribute('data-swipe')).not.toBe('open');
  });
});

describe('层栈：快捷键只有一个入口，层开着时让给栈顶', () => {
  const press = (init: KeyboardEventInit): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(e);
    return e;
  };

  function Layer({ modal, onKey, onEsc }: { modal: boolean; onKey(): void; onEsc(): void }) {
    const box = { current: null as HTMLDivElement | null };
    const h: LayerHandle = useLayer(true, { name: modal ? 'm' : 'n', modal, el: () => box.current, onEsc });
    useKeys({ 'mod+Enter': () => (onKey(), true) }, h);
    return <div ref={(el) => void (box.current = el)} data-testid={modal ? 'modal' : 'plain'} />;
  }

  function Page({ layer, page, onKey = () => undefined, onEsc = () => undefined }: { layer: 'none' | 'modal' | 'plain'; page(): void; onKey?(): void; onEsc?(): void }) {
    useKeys({ 'mod+k': () => (page(), true) });
    return layer === 'none' ? null : <Layer modal={layer === 'modal'} onKey={onKey} onEsc={onEsc} />;
  }

  it('没有层：页面的 Ctrl+K 照常；模态层开着：页面的收不到，层自己登记的照常；非模态层开着：页面的照常', () => {
    const page = vi.fn();
    const own = vi.fn();
    const { rerender } = render(<Page layer="none" page={page} />);
    expect(press({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(page).toHaveBeenCalledTimes(1);
    rerender(<Page layer="modal" page={page} onKey={own} />);
    expect(press({ key: 'k', ctrlKey: true }).defaultPrevented, '让给模态层：页面的不接').toBe(false);
    expect(page).toHaveBeenCalledTimes(1);
    press({ key: 'Enter', ctrlKey: true });
    expect(own).toHaveBeenCalledTimes(1);
    rerender(<Page layer="plain" page={page} onKey={own} />);
    press({ key: 'k', ctrlKey: true });
    expect(page).toHaveBeenCalledTimes(2);
  });

  it('层关了，它登记的键不再生效（不落回页面）', () => {
    const own = vi.fn();
    function Gone({ open }: { open: boolean }) {
      const h = useLayer(open, { name: 'g' });
      useKeys({ 'mod+Enter': () => (own(), true) }, h);
      return null;
    }
    const { rerender } = render(<Gone open />);
    press({ key: 'Enter', ctrlKey: true });
    rerender(<Gone open={false} />);
    press({ key: 'Enter', ctrlKey: true });
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('Esc 只给栈顶、拦下不再往下传；输入法组字中（含 keyCode 229）只拦不关；入栈、出栈、Esc 各记一行（不记内容）', () => {
    const esc = vi.fn();
    const below = vi.fn();
    document.addEventListener('keydown', below);
    const { unmount } = render(<Page layer="modal" page={() => undefined} onEsc={esc} />);
    press({ key: 'Escape', isComposing: true });
    press({ key: 'Escape', keyCode: 229 });
    expect(esc).not.toHaveBeenCalled();
    press({ key: 'Escape' });
    expect(esc).toHaveBeenCalledTimes(1);
    expect(below, '栈里有层时 Esc 不再传给 document 上的监听（Radix、抽屉都收不到）').not.toHaveBeenCalled();
    unmount();
    press({ key: 'Escape' });
    expect(below, '栈空了照常往下传').toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', below);
    expect(lines).toEqual(['layer push m n=1', 'layer esc m n=1', 'layer pop m n=0']);
  });

  it('非模态层在栈顶、焦点在它外面：Esc 先给焦点所在的元素（接住了就不关层），没人接才关栈顶；下面的 Radix 看到 defaultPrevented 不自己关', () => {
    const esc = vi.fn();
    const own = vi.fn();
    const radix = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    document.addEventListener('keydown', radix, true);
    function Recorder() {
      return (
        <button
          type="button"
          data-testid="rec"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            own();
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      );
    }
    render(
      <>
        <Recorder />
        <Page layer="plain" page={() => undefined} onEsc={esc} />
      </>,
    );
    screen.getByTestId('rec').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(own, '录快捷键的框收到了 Esc').toHaveBeenCalledTimes(1);
    expect(esc, '框接住了，不关层').not.toHaveBeenCalled();
    expect(radix.mock.results[0]?.value, '下面 Radix 的监听看到的是 defaultPrevented').toBe(true);
    press({ key: 'Escape' });
    expect(esc, '焦点在别处没人接：冒泡回窗口交给栈顶').toHaveBeenCalledTimes(1);
    screen.getByTestId('plain').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(esc, '焦点在层里：捕获阶段直接交给它').toHaveBeenCalledTimes(2);
    expect(radix, '焦点在层里时 document 上的监听收不到').toHaveBeenCalledTimes(2);
    document.removeEventListener('keydown', radix, true);
  });

  it('焦点在非模态层的根里（电脑详情抽屉）：不带 mod 的页面键不生效、Ctrl+N 这类照常；焦点回到页面上照常；组字中（keyCode 229）页面的键也不生效', () => {
    const page = vi.fn();
    const ctrlN = vi.fn();
    function Arrow() {
      useKeys({ ArrowLeft: () => (page(), true), 'mod+n': () => (ctrlN(), true) });
      return null;
    }
    render(
      <>
        <Arrow />
        <Page layer="plain" page={() => undefined} />
      </>,
    );
    screen.getByTestId('plain').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    expect(page).not.toHaveBeenCalled();
    screen.getByTestId('plain').dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(ctrlN).toHaveBeenCalledTimes(1);
    press({ key: 'ArrowLeft', keyCode: 229 });
    expect(page).not.toHaveBeenCalled();
    press({ key: 'ArrowLeft' });
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('键名：不带 mod 的方向键和字母按着 Shift 前面加 shift+；Shift 换了字的符号键不加', () => {
    const k = (i: KeyboardEventInit) => keyName(new KeyboardEvent('keydown', i));
    expect(k({ key: 'ArrowLeft' })).toBe('ArrowLeft');
    expect(k({ key: 'ArrowLeft', shiftKey: true })).toBe('shift+ArrowLeft');
    expect(k({ key: 'T', shiftKey: true })).toBe('shift+t');
    expect(k({ key: 'T' }), '大写锁定不算 Shift').toBe('t');
    expect(k({ key: '?', shiftKey: true })).toBe('?');
    expect(k({ key: 'n', ctrlKey: true, shiftKey: true })).toBeNull();
  });

  it('模态层下面晚挂到 body 上的浮层（例如弹层里打开的 Popover）：它在栈顶时不 inert，弹层在它下面也不 inert', async () => {
    function Pop() {
      const box = useRef<HTMLDivElement | null>(null);
      useLayer(true, { name: 'pop', el: () => box.current });
      useEffect(() => {
        // 模拟 Radix 的 Portal：挂上以后下一轮才把内容挂到 body 下（ref 和插进 DOM 在同一个任务里）
        const id = setTimeout(() => {
          const d = document.createElement('div');
          d.setAttribute('data-testid', 'pop');
          box.current = d;
          document.body.append(d);
        }, 0);
        return () => clearTimeout(id);
      }, []);
      return null;
    }
    function Host() {
      const [pop, setPop] = useState(false);
      return (
        <Dialog open onOpenChange={() => undefined} title="D">
          <button type="button" data-testid="open-pop" onClick={() => setPop(true)}>
            p
          </button>
          {pop ? <Pop /> : null}
        </Dialog>
      );
    }
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByTestId('open-pop'));
    const pop = await screen.findByTestId('pop');
    await waitFor(() => expect(inInert(pop)).toBe(false));
    expect(inInert(screen.getByTestId('open-pop'))).toBe(false);
  });
});
