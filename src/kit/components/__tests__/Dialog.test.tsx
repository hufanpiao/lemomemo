// 弹层描述的 id 不能写死（两个弹层同时打开时会重名）：id 和 aria-describedby 都交给 Radix 管，每个弹层各生成一个、各指各的
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog } from '../Dialog.tsx';

const noop = () => undefined;

describe('Dialog 的描述 id', () => {
  afterEach(cleanup);

  it('两个弹层同时打开：描述 id 不同，各自的 aria-describedby 指向自己的描述', () => {
    render(
      <>
        <Dialog open onOpenChange={noop} title="t1" description="desc-one" />
        <Dialog open onOpenChange={noop} title="t2" description="desc-two" />
      </>,
    );
    const one = screen.getByText('desc-one');
    const two = screen.getByText('desc-two');
    expect(one.id).not.toBe('');
    expect(two.id).not.toBe('');
    expect(one.id).not.toBe(two.id);
    expect(document.querySelectorAll(`[id="${one.id}"]`)).toHaveLength(1);
    expect(document.querySelectorAll(`[id="${two.id}"]`)).toHaveLength(1);

    const dialogs = screen.getAllByRole('dialog', { hidden: true });
    expect(dialogs).toHaveLength(2);
    for (const [d, own, other] of [
      [dialogs[0], one, two],
      [dialogs[1], two, one],
    ] as const) {
      // aria-describedby 是空格分开的 id 列表：要含自己的描述，不含另一个弹层的
      const ids = (d?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      // 每个 id 在页面上都必须恰好对应一个元素（不能指向不存在的元素，Radix 会把传进来的值和它自己的 id 拼在一起）
      for (const id of ids) expect(document.querySelectorAll(`[id="${id}"]`), `aria-describedby 里的 ${id}`).toHaveLength(1);
      expect(ids).toContain(own.id);
      expect(ids).not.toContain(other.id);
      expect(d?.contains(own)).toBe(true);
    }
  });

  it('没有描述时不写 aria-describedby', () => {
    render(<Dialog open onOpenChange={noop} title="t" />);
    expect(screen.getByRole('dialog').hasAttribute('aria-describedby')).toBe(false);
  });
});

// FA-6 ② 审查 L4：使用方都是自己的按钮打开、不用 RD.Trigger；关掉以后焦点要回到打开它的按钮（Radix 默认还给空的 triggerRef，焦点停在 body）
describe('Dialog 关掉以后焦点回到打开前的元素', () => {
  afterEach(cleanup);

  function Host({ dropOpener = false }: { dropOpener?: boolean }) {
    const [open, setOpen] = useState(false);
    const [gone, setGone] = useState(false);
    return (
      <>
        {gone ? null : (
          <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
            open
          </button>
        )}
        <Dialog open={open} onOpenChange={setOpen} title="t">
          <button type="button" data-testid="cancel" onClick={() => setOpen(false)}>
            cancel
          </button>
          {dropOpener ? (
            <button type="button" data-testid="drop" onClick={() => setGone(true)}>
              drop
            </button>
          ) : null}
        </Dialog>
      </>
    );
  }

  for (const how of ['Esc', '在“取消”上按回车'] as const) {
    it(`${how}关掉：焦点回到打开按钮`, async () => {
      const user = userEvent.setup();
      render(<Host />);
      const opener = screen.getByTestId('opener');
      opener.focus();
      await user.keyboard('{Enter}');
      await screen.findByRole('dialog');
      await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement), '打开以后焦点在弹层里').toBe(true));
      if (how === 'Esc') await user.keyboard('{Escape}');
      else {
        screen.getByTestId('cancel').focus();
        await user.keyboard('{Enter}');
      }
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 3000 });
      expect(document.activeElement).toBe(opener);
    });
  }

  it('打开按钮在弹层开着时被移走了：不报错，焦点不硬塞回去', async () => {
    const user = userEvent.setup();
    render(<Host dropOpener />);
    screen.getByTestId('opener').focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('drop'));
    expect(screen.queryByTestId('opener')).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 3000 });
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  });
});
