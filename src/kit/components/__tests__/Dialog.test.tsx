// 弹层描述的 id 不能写死（两个弹层同时打开时会重名）：id 和 aria-describedby 都交给 Radix 管，每个弹层各生成一个、各指各的
import { cleanup, render, screen } from '@testing-library/react';
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
