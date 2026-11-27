// Dialog 还焦点（第 1 批审查 docs/03-评审/B2/B2-审查-Dialog收尾与sub-low与wallclock.md 二）：
// • M1：提前还焦点时打开按钮还在 aria-hidden 里；卸载（aria-hidden 撤掉）以后焦点还在它上面，就重新聚焦一次让读屏补报
// • D-L1：关上时打开按钮被禁用、退场途中又恢复可用：卸载时补还给它
// • D-L2：关的途中用户已经把焦点放到别处：卸载时不抢回来
// • D-L3：给了退路、打开按钮也正常：先还打开按钮，不走退路
// • D-L4：还的目标聚焦不上（focus() 没生效）：接着试退路
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog } from '../Dialog.tsx';
import { loadMotionFeatures } from '../../../motion/index.ts';

// 动画实现首屏画完以后才由 main.tsx 下载（R-354）；这里没有 main.tsx，测退场和焦点前先等它到
await loadMotionFeatures();

const gone = (): boolean => document.querySelector('[role="dialog"]') === null;
const inHidden = (el: Element | null): boolean => el?.closest('[aria-hidden="true"]') != null;

/** 外面能改打开按钮的 disabled；confirm 关上并（可选）同时禁用打开按钮 */
let setOff: (v: boolean) => void = () => undefined;
function Host({ disableOnConfirm = false, withFallback = false }: { disableOnConfirm?: boolean; withFallback?: boolean }) {
  const [open, setOpen] = useState(false);
  const [off, _setOff] = useState(false);
  setOff = _setOff;
  return (
    <>
      <h2 tabIndex={-1} data-testid="fallback">
        section
      </h2>
      <button type="button" data-testid="opener" disabled={off} onClick={() => setOpen(true)}>
        open
      </button>
      <button type="button" data-testid="other">
        other
      </button>
      <Dialog open={open} onOpenChange={setOpen} title="t" {...(withFallback ? { returnFocus: () => document.querySelector<HTMLElement>('[data-testid="fallback"]') } : {})}>
        <button
          type="button"
          data-testid="confirm"
          onClick={() => {
            if (disableOnConfirm) setOff(true);
            setOpen(false);
          }}
        >
          confirm
        </button>
      </Dialog>
    </>
  );
}

async function openFrom(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const opener = screen.getByTestId('opener');
  opener.focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true));
  return opener;
}

describe('Dialog 还焦点：读屏补报、卸载时补还、不抢、退路优先级（第 1 批审查 M1、D-L1～D-L4）', () => {
  afterEach(cleanup);

  it('M1：Esc 以后提前还到打开按钮（这时在 aria-hidden 里）；卸载、aria-hidden 撤掉以后重新聚焦一次', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const opener = await openFrom(user);
    let focusCount = 0;
    opener.addEventListener('focus', () => focusCount++);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(opener);
    expect(gone()).toBe(false);
    expect(inHidden(opener), '退场途中页面其余部分还带着 aria-hidden（Radix hideOthers）').toBe(true);
    expect(focusCount).toBe(1);
    await waitFor(() => expect(gone()).toBe(true), { timeout: 3000 });
    await waitFor(() => expect(focusCount).toBe(2));
    expect(document.activeElement).toBe(opener);
    expect(inHidden(document.activeElement)).toBe(false);
  });

  it('D-L1：关上时打开按钮被禁用，退场途中又恢复可用：卸载时补还给它', async () => {
    const user = userEvent.setup();
    render(<Host disableOnConfirm />);
    const opener = await openFrom(user);
    await user.click(screen.getByTestId('confirm'));
    expect(gone()).toBe(false);
    expect(document.activeElement).not.toBe(opener);
    act(() => setOff(false));
    await waitFor(() => expect(gone()).toBe(true), { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('D-L2：关的途中用户已经把焦点放到页面上另一个按钮：卸载以后不抢回来', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const opener = await openFrom(user);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(opener);
    const other = screen.getByTestId('other');
    other.focus();
    await waitFor(() => expect(gone()).toBe(true), { timeout: 3000 });
    await act(async () => new Promise((r) => setTimeout(r, 20))); // Radix 在卸载后的 setTimeout 里派 onCloseAutoFocus
    expect(document.activeElement).toBe(other);
  });

  it('D-L3：给了退路、打开按钮也正常：焦点回到打开按钮，不走退路', async () => {
    const user = userEvent.setup();
    render(<Host withFallback />);
    const opener = await openFrom(user);
    await user.click(screen.getByTestId('confirm'));
    expect(document.activeElement).toBe(opener);
    await waitFor(() => expect(gone()).toBe(true), { timeout: 3000 });
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(document.activeElement).toBe(opener);
  });

  it('D-L4：打开按钮 focus() 没生效（聚焦不上）：接着试退路', async () => {
    const user = userEvent.setup();
    render(<Host withFallback />);
    const opener = await openFrom(user);
    // 模拟在 inert 里、被隐藏等聚焦不上的情形：focus() 什么也不做
    opener.focus = () => undefined;
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('fallback')));
    await waitFor(() => expect(gone()).toBe(true), { timeout: 3000 });
    expect(document.activeElement).toBe(screen.getByTestId('fallback'));
  });
});
