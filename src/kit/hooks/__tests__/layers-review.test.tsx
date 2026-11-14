// 层栈（kit/hooks/layers.ts、useLayer.ts）11-14 整块评审补的几种情形：
// • 模态层开着时直接卸掉组件（跳页）：inert、scroll-locked 撤干净
// • 下层先关、打开上层的按钮跟着卸掉：上层关时焦点退到下层的打开按钮
// • 打开它的元素在打开那次渲染时记（层在 layout 阶段挪焦点也不影响）
// • StrictMode 双挂载；我们设的 inert 被 React 撤掉时补上；body 下的播报区有按钮照样 inert；热替换（resetLayers）撤干净
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../../components/Dialog.tsx';
import { resetLayers, useKeys } from '../layers.ts';
import { useLayer } from '../useLayer.ts';

const lines: string[] = [];
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: (l: string) => lines.push(l) }));

afterEach(() => {
  lines.length = 0;
  cleanup();
  resetLayers();
  document.body.replaceChildren();
});

describe('层栈：11-14 整块评审补的几种情形', () => {
  const locked = (): boolean => document.documentElement.classList.contains('scroll-locked');
  const noInert = (): boolean => document.querySelector('[inert]') === null;

  it('模态层开着时直接卸掉组件（跳页）：inert、scroll-locked 撤干净', async () => {
    const { unmount } = render(
      <Dialog open onOpenChange={() => undefined} title="D">
        <button type="button">好</button>
      </Dialog>,
    );
    await waitFor(() => expect(document.querySelector('[inert]')).not.toBeNull());
    expect(locked()).toBe(true);
    unmount();
    expect(noInert()).toBe(true);
    expect(locked()).toBe(false);
  });

  it('下层先关（打开上层的按钮跟着卸掉）：上层再关时焦点退到下层的打开按钮，不掉到 body', () => {
    function Box({ name, children, testId }: { name: string; children?: ReactNode; testId: string }) {
      const box = useRef<HTMLDivElement>(null);
      useLayer(true, { name, el: () => box.current });
      return (
        <div ref={box} data-testid={testId}>
          {children}
        </div>
      );
    }
    function Host({ a, b }: { a: boolean; b: boolean }) {
      return (
        <>
          <button type="button" data-testid="open-a">
            a
          </button>
          {a ? (
            <Box name="a" testId="a">
              <button type="button" data-testid="open-b">
                b
              </button>
            </Box>
          ) : null}
          {b ? (
            <Box name="b" testId="b">
              <button type="button" data-testid="in-b">
                x
              </button>
            </Box>
          ) : null}
        </>
      );
    }
    const { rerender } = render(<Host a={false} b={false} />);
    screen.getByTestId('open-a').focus();
    rerender(<Host a b={false} />);
    screen.getByTestId('open-b').focus();
    rerender(<Host a b />);
    screen.getByTestId('in-b').focus();
    rerender(<Host a={false} b />);
    rerender(<Host a={false} b={false} />);
    expect(document.activeElement).toBe(screen.getByTestId('open-a'));
  });

  it('打开它的元素在打开那次渲染时记：层在 layout 阶段把焦点挪进去，关了照样还给原来的按钮', () => {
    function Moves() {
      const box = useRef<HTMLDivElement>(null);
      const inner = useRef<HTMLButtonElement>(null);
      useLayer(true, { name: 'mv', el: () => box.current });
      useLayoutEffect(() => inner.current?.focus(), []);
      return (
        <div ref={box}>
          <button ref={inner} type="button" data-testid="inner">
            i
          </button>
        </div>
      );
    }
    function Host({ open }: { open: boolean }) {
      return (
        <>
          <button type="button" data-testid="trigger">
            t
          </button>
          {open ? <Moves /> : null}
        </>
      );
    }
    const { rerender } = render(<Host open={false} />);
    screen.getByTestId('trigger').focus();
    rerender(<Host open />);
    expect(document.activeElement).toBe(screen.getByTestId('inner'));
    rerender(<Host open={false} />);
    expect(document.activeElement).toBe(screen.getByTestId('trigger'));
  });

  it('StrictMode 双挂载：栈里只剩一层；关了 inert、scroll-locked 撤干净', async () => {
    const { rerender } = render(
      <StrictMode>
        <Dialog open onOpenChange={() => undefined} title="S">
          <button type="button">好</button>
        </Dialog>
      </StrictMode>,
    );
    await waitFor(() => expect(document.querySelector('[inert]')).not.toBeNull());
    expect(lines.filter((l) => l.startsWith('layer push')).length - lines.filter((l) => l.startsWith('layer pop')).length).toBe(1);
    rerender(
      <StrictMode>
        <Dialog open={false} onOpenChange={() => undefined} title="S" />
      </StrictMode>,
    );
    expect(lines.at(-1)).toBe('layer pop dialog n=0');
    expect(noInert()).toBe(true);
    expect(locked()).toBe(false);
  });

  it('我们设的 inert 被 React 改了属性（撤掉）：模态层还开着就补上；关了照样撤掉', async () => {
    function Side({ on }: { on: boolean }) {
      return createPortal(<div data-testid="side" inert={on} />, document.body);
    }
    function Host({ on, open }: { on: boolean; open: boolean }) {
      return (
        <>
          <Side on={on} />
          <Dialog open={open} onOpenChange={() => undefined} title="R">
            <button type="button">好</button>
          </Dialog>
        </>
      );
    }
    const { rerender } = render(<Host on={false} open />);
    const side = screen.getByTestId('side');
    await waitFor(() => expect(side.hasAttribute('inert')).toBe(true));
    rerender(<Host on open />);
    rerender(<Host on={false} open />);
    await waitFor(() => expect(side.hasAttribute('inert'), '补上').toBe(true));
    rerender(<Host on={false} open={false} />);
    expect(side.hasAttribute('inert'), '关了撤掉').toBe(false);
  });

  it('body 下的播报区：里面没有能聚焦的元素不 inert；有按钮（提示条的“撤销”）照样 inert', async () => {
    const quiet = document.createElement('div');
    quiet.setAttribute('aria-live', 'polite');
    const loud = document.createElement('div');
    loud.setAttribute('aria-live', 'polite');
    loud.append(document.createElement('button'));
    document.body.append(quiet, loud);
    render(
      <Dialog open onOpenChange={() => undefined} title="L">
        <button type="button">好</button>
      </Dialog>,
    );
    await waitFor(() => expect(loud.hasAttribute('inert')).toBe(true));
    expect(quiet.hasAttribute('inert')).toBe(false);
  });

  it('热替换换掉模块前（resetLayers）：撤掉我们设的 inert、scroll-locked，按键不再接', () => {
    const own = vi.fn();
    function M() {
      const box = useRef<HTMLDivElement>(null);
      const h = useLayer(true, { name: 'hmr', modal: true, el: () => box.current, onEsc: own });
      useKeys({ 'mod+Enter': () => (own(), true) }, h);
      return createPortal(<div ref={box} />, document.body);
    }
    const keep = document.createElement('div');
    keep.setAttribute('inert', '');
    document.body.append(keep);
    render(<M />);
    expect(document.querySelectorAll('[inert]').length).toBeGreaterThan(1);
    resetLayers();
    expect([...document.querySelectorAll('[inert]')], '别处设的不碰').toEqual([keep]);
    expect(locked()).toBe(false);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(own).not.toHaveBeenCalled();
  });
});
