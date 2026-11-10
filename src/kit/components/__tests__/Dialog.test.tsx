// 弹层描述的 id 不能写死（两个弹层同时打开时会重名）：id 和 aria-describedby 都交给 Radix 管，每个弹层各生成一个、各指各的
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog } from '../Dialog.tsx';
import styles from '../Dialog.module.css';
import { loadMotionFeatures } from '../../../motion/index.ts';

// 动画实现首屏画完以后才由 main.tsx 下载（R-354）；这里没有 main.tsx，测退场和焦点前先等它到
await loadMotionFeatures();

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

// MOTION-②-low 与 Dialog 焦点审查（11-05）：L-1 关上那一刻就还、不等卸载；L-2 退路；L-3 canRefocus 的 disabled、body 两个分支
describe('Dialog 还焦点的时机、退路（审查 L-1～L-3）', () => {
  afterEach(cleanup);

  function Host2({ disableOpener = false, dropOpener = false, withFallback = false }: { disableOpener?: boolean; dropOpener?: boolean; withFallback?: boolean }) {
    const [open, setOpen] = useState(false);
    const [off, setOff] = useState(false);
    return (
      <>
        <h2 tabIndex={-1} data-testid="fallback">
          section
        </h2>
        {off && dropOpener ? null : (
          <button type="button" data-testid="opener" disabled={off && disableOpener} onClick={() => setOpen(true)}>
            open
          </button>
        )}
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="t"
          {...(withFallback ? { returnFocus: () => document.querySelector<HTMLElement>('[data-testid="fallback"]') } : {})}
        >
          <button
            type="button"
            data-testid="confirm"
            onClick={() => {
              setOff(true);
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

  it('L-1：Esc 关上以后，弹层还在退场（没卸载）时焦点已经回到打开按钮', async () => {
    const user = userEvent.setup();
    render(<Host2 />);
    const opener = await openFrom(user);
    await user.keyboard('{Escape}');
    // 退场动画还在：弹层节点还在文档里
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(opener);
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull(), { timeout: 3000 });
    expect(document.activeElement).toBe(opener);
  });

  it('L-3：打开按钮在关上时被禁用：不还给它、不抛错；没给退路就留在 body', async () => {
    const user = userEvent.setup();
    render(<Host2 disableOpener />);
    const opener = await openFrom(user);
    await user.click(screen.getByTestId('confirm'));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull(), { timeout: 3000 });
    expect((opener as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  });

  it('L-2：打开按钮被禁用、给了退路：焦点落在退路上', async () => {
    const user = userEvent.setup();
    render(<Host2 disableOpener withFallback />);
    await openFrom(user);
    await user.click(screen.getByTestId('confirm'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('fallback')));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull(), { timeout: 3000 });
    expect(document.activeElement).toBe(screen.getByTestId('fallback'));
  });

  it('L-2：打开按钮被移走、给了退路：焦点落在退路上', async () => {
    const user = userEvent.setup();
    render(<Host2 dropOpener withFallback />);
    await openFrom(user);
    await user.click(screen.getByTestId('confirm'));
    expect(screen.queryByTestId('opener')).toBeNull();
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull(), { timeout: 3000 });
    expect(document.activeElement).toBe(screen.getByTestId('fallback'));
  });

  it('L-3：打开时焦点在 body（没有可还的元素）：不还给 body；给了退路就给退路', async () => {
    function Ctl({ withFallback }: { withFallback: boolean }) {
      const [open, setOpen] = useState(true);
      return (
        <>
          <h2 tabIndex={-1} data-testid="fallback">
            section
          </h2>
          <Dialog open={open} onOpenChange={setOpen} title="t" {...(withFallback ? { returnFocus: () => document.querySelector<HTMLElement>('[data-testid="fallback"]') } : {})}>
            <button type="button" data-testid="close" onClick={() => setOpen(false)}>
              close
            </button>
          </Dialog>
        </>
      );
    }
    for (const withFallback of [false, true]) {
      (document.activeElement as HTMLElement | null)?.blur();
      const user = userEvent.setup();
      const { unmount } = render(<Ctl withFallback={withFallback} />);
      await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true));
      await user.click(screen.getByTestId('close'));
      await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull(), { timeout: 3000 });
      if (withFallback) expect(document.activeElement).toBe(screen.getByTestId('fallback'));
      else expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
      unmount();
    }
  });
});

describe('Dialog 的 lead、center（B3 S23，负责人 11-10：麦克风说明卡按线框 s10 加图标、居中）', () => {
  afterEach(cleanup);

  it('不传：内容区类名只有原来那一个，标题是第一个子元素，没有 lead 容器（和改之前完全一样）', () => {
    render(<Dialog open onOpenChange={noop} title="t" description="d" />);
    const d = screen.getByRole('dialog', { hidden: true });
    expect(d.className).toBe(styles.content);
    expect(d.firstElementChild?.tagName).toBe('H2');
    expect(d.firstElementChild?.textContent).toBe('t');
    expect(d.querySelector(`.${styles.lead}`)).toBeNull();
    expect(d.querySelector(`.${styles.center}`)).toBeNull();
  });

  it('lead={null}：不多出 lead 容器，标题仍是第一个子元素（S23 代码审建议 5）', () => {
    render(<Dialog open onOpenChange={noop} title="t" lead={null} />);
    const d = screen.getByRole('dialog', { hidden: true });
    expect(d.querySelector(`.${styles.lead}`)).toBeNull();
    expect(d.firstElementChild?.tagName).toBe('H2');
  });

  it('center={false} 和不传一样', () => {
    render(<Dialog open onOpenChange={noop} title="t" center={false} />);
    expect(screen.getByRole('dialog', { hidden: true }).className).toBe(styles.content);
  });

  it('传 lead、center：lead 排在标题前面，内容区多一个居中类', () => {
    render(<Dialog open onOpenChange={noop} title="t" description="d" lead={<i data-testid="ico" />} center />);
    const d = screen.getByRole('dialog', { hidden: true });
    expect(d.className).toBe(`${styles.content} ${styles.center}`);
    const first = d.firstElementChild;
    expect(first?.className).toBe(styles.lead);
    expect(first?.querySelector('[data-testid="ico"]')).not.toBeNull();
    expect(first?.nextElementSibling?.textContent).toBe('t');
    // 标题仍然是弹层的可访问名称
    expect(screen.getByRole('dialog', { hidden: true, name: 't' })).toBe(d);
  });
});
