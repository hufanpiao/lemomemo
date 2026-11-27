// 静态列表换成动画实现的时机（R-354 做法 A，方案第 2 节、风险 K2；./swap-guard.ts）：
// 今天页冷启动时列表是门面画的静态；动画实现到了以后整个列表重挂一次换上（DOM 一样）。重挂会丢焦点和行内状态，所以：
// • 焦点在列表里：不换，失焦以后才换
// • 有按住不放的指针：不换，松开以后才换
// • useHoldView 停一拍期间：不换，停完才换
// • 没有这些：一到就换；换完以后删行有退场（data-state="leaving"），换之前是当场移除
// 判断“换了没有”看列表外壳是不是新的元素（重挂会换掉 DOM 节点）
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Appear, AppearItem, AppearList, useHoldView } from '../components.ts';
import { loadMotionFeatures, resetMotionFeaturesForTest } from '../features.ts';
import { resetSwapGuardForTest, SWAP_RETRY_MS } from '../swap-guard.ts';

afterEach(() => {
  cleanup();
  resetMotionFeaturesForTest();
  resetSwapGuardForTest();
});

const wait = (ms: number) => act(() => new Promise<void>((ok) => setTimeout(ok, ms)));
const arrive = () =>
  act(async () => {
    await loadMotionFeatures();
  });

function List({ ids, hold = false }: { ids: string[]; hold?: boolean }) {
  const h = useHoldView(ids);
  const { hold: start } = h;
  useEffect(() => {
    if (hold) start();
  }, [hold, start]);
  return (
    <AppearList as="ul" data-testid="list">
      {h.view.map((id) => (
        <AppearItem key={id} as="li" data-id={id}>
          <button type="button">{id}</button>
        </AppearItem>
      ))}
    </AppearList>
  );
}

const ul = (c: HTMLElement) => c.querySelector('ul');

describe('静态列表换成动画实现（R-354 K2）', () => {
  it('换之前删行当场移除；没有守卫时一到就换，换完删行有退场', async () => {
    const { container, rerender } = render(<List ids={['a', 'b']} />);
    const before = ul(container);
    rerender(<List ids={['a']} />);
    expect(container.querySelector('[data-id="b"]'), '静态时删行当场移除').toBeNull();
    rerender(<List ids={['a', 'b']} />);
    await arrive();
    expect(ul(container), '一到就换（重挂成新的外壳）').not.toBe(before);
    expect(container.querySelector('[data-id="a"]')?.getAttribute('style')).toBe('opacity: 1;');
    rerender(<List ids={['a']} />);
    expect(container.querySelector<HTMLElement>('[data-id="b"]')?.dataset['state'], '换完删行有退场').toBe('leaving');
  });

  it('焦点在列表里：不换；失焦以后才换，焦点不丢', async () => {
    const { container } = render(<List ids={['a', 'b']} />);
    const before = ul(container);
    const btn = container.querySelector<HTMLButtonElement>('[data-id="a"] button');
    btn?.focus();
    await arrive();
    await wait(SWAP_RETRY_MS * 2);
    expect(ul(container), '焦点在列表里时不换').toBe(before);
    expect(document.activeElement).toBe(btn);
    btn?.blur();
    await wait(SWAP_RETRY_MS * 2);
    expect(ul(container), '失焦以后换上').not.toBe(before);
  });

  it('按住不放：不换；松开以后才换', async () => {
    const { container } = render(<List ids={['a']} />);
    const before = ul(container);
    const btn = container.querySelector('[data-id="a"] button');
    if (!btn) throw new Error('no btn');
    fireEvent.pointerDown(btn, { pointerId: 7 });
    await arrive();
    await wait(SWAP_RETRY_MS * 2);
    expect(ul(container), '按住期间不换').toBe(before);
    fireEvent.pointerUp(btn, { pointerId: 7 });
    await wait(SWAP_RETRY_MS * 2);
    expect(ul(container), '松开以后换上').not.toBe(before);
  });

  it('停一拍期间：不换；停完才换', async () => {
    const { container, rerender } = render(<List ids={['a', 'b']} />);
    const before = ul(container);
    rerender(<List ids={['a', 'b']} hold />);
    await arrive();
    await wait(SWAP_RETRY_MS);
    expect(ul(container), '停一拍期间不换').toBe(before);
    // 停一拍最多 --dur-ui（0.22 s），之后自动放开。分几次短等：一次长的 act 里 React 会把放开那一下攒到 act 结束才画
    for (let i = 0; i < 8; i += 1) await wait(SWAP_RETRY_MS);
    expect(ul(container), '停完换上').not.toBe(before);
  });

  it('到了以后才挂上的列表直接用动画实现（不先画静态再换）', async () => {
    await arrive();
    const { container, rerender } = render(<List ids={['a', 'b']} />);
    const first = ul(container);
    await wait(SWAP_RETRY_MS * 2);
    expect(ul(container)).toBe(first);
    rerender(<List ids={['a']} />);
    expect(container.querySelector<HTMLElement>('[data-id="b"]')?.dataset['state']).toBe('leaving');
  });
});

// R-354 M1（负责人选“修掉”）：实现到达前就已显示的提示条（提醒横幅、冲突卡等），到了以后按“已停稳”换成实现，关掉时有退场淡出
describe('已显示的 Appear 换成动画实现（R-354 M1）', () => {
  const Toast = ({ show }: { show: boolean }) => (
    <Appear kind="toast" show={show}>
      <button type="button">x</button>
    </Appear>
  );
  const box = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-appear="toast"]');

  it('实现晚到：换上以后 DOM 一样（停稳、不播入场），关掉时有退场', async () => {
    const { container, rerender } = render(<Toast show />);
    const before = box(container);
    expect(before?.getAttribute('style')).toBe('opacity: 1; transform: none;');
    await arrive();
    await wait(10);
    const after = box(container);
    expect(after, '换成了实现').not.toBe(before);
    expect(after?.getAttribute('style'), '停稳的样子，没有入场').toBe('opacity: 1; transform: none;');
    rerender(<Toast show={false} />);
    expect(box(container)?.dataset['state'], '关掉有退场').toBe('leaving');
  });

  it('焦点在提示条里：不换，关掉当场移除；下次显示交给实现、照常播入场', async () => {
    const { container, rerender } = render(<Toast show />);
    container.querySelector('button')?.focus();
    const before = box(container);
    await arrive();
    await wait(SWAP_RETRY_MS * 2);
    expect(box(container), '焦点在里面不换').toBe(before);
    expect(document.activeElement?.tagName).toBe('BUTTON');
    rerender(<Toast show={false} />);
    expect(box(container), '没换成的当场移除').toBeNull();
    rerender(<Toast show />);
    expect(box(container)?.getAttribute('style'), '新的一次照常播入场（不是停稳）').not.toBe('opacity: 1; transform: none;');
  });

  it('按住不放：松开以后才换', async () => {
    const { container } = render(<Toast show />);
    const before = box(container);
    fireEvent.pointerDown(document.body, { pointerId: 7 });
    await arrive();
    await wait(SWAP_RETRY_MS * 2);
    expect(box(container)).toBe(before);
    fireEvent.pointerUp(document.body, { pointerId: 7 });
    await wait(SWAP_RETRY_MS * 2);
    expect(box(container)).not.toBe(before);
  });
});
