// 列表增删（架构 17.1、17.4 B2；B2 FA-5）：jsdom 不画画面，这里证明结构和参数——
// 第一次画不播入场；新加的只淡入、晚 --dur-ui 的一半、淡入播完前 entering 不接点按；删掉的先留着（data-state="leaving"）、立刻绝对定位移出文档流、
// 沉到别的行下面（z-index -1，外壳 isolation: isolate），淡出 --dur-ui 的一半，播完才卸载；减少动态效果只淡入淡出、不等
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { itemMotion } from '../AppearList.tsx';
import { AppearItem, AppearList } from '../components.ts';
import { dur, ease, LIST_LAYOUT_LAG, tr } from '../tokens.ts';
import { loadMotionFeatures } from '../features.ts';

// 动效功能包异步加载（B2 FA-6 ②）：这里测的是功能包到了以后的手感，先等它到（真实页面里首屏画完后才有人操作）
await loadMotionFeatures();

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset['rm'];
});

let setIds: (ids: string[]) => void = () => undefined;
function Harness({ start }: { start: string[] }) {
  const [ids, set] = useState(start);
  setIds = set;
  return (
    <AppearList as="ul" data-testid="list">
      {ids.map((id) => (
        <AppearItem key={id} data-testid={`row-${id}`}>
          {id}
        </AppearItem>
      ))}
    </AppearList>
  );
}
const row = (id: string) => screen.queryByTestId(`row-${id}`);

describe('AppearList / AppearItem', () => {
  it('第一次画：直接到位，不逐条入场；画成 li、套在 ul 里', () => {
    render(<Harness start={['a', 'b']} />);
    expect(row('a')?.tagName).toBe('LI');
    expect(row('a')?.parentElement).toBe(screen.getByTestId('list'));
    expect(row('a')?.style.opacity).not.toBe('0');
  });

  it('新加的一条只淡入、不上移；删掉的先留着播退出，期间 data-state="leaving"、立刻移出文档流（绝对定位），播完才卸载', async () => {
    render(<Harness start={['a']} />);
    expect(row('a')?.dataset['state']).toBeUndefined();
    act(() => setIds(['a', 'b']));
    expect(row('b')?.style.opacity).toBe('0');
    expect(row('b')?.style.transform ?? '').not.toContain('translateY');
    // 淡入播完以前不接点按（第二轮 L3）
    expect(row('b')?.dataset['state']).toBe('entering');
    expect(row('b')?.style.pointerEvents).toBe('none');
    await waitFor(() => expect(row('b')?.dataset['state']).toBeUndefined());
    expect(row('b')?.style.pointerEvents).toBe('');
    act(() => setIds(['b']));
    expect(row('a')?.dataset['state']).toBe('leaving');
    expect(row('a')?.style.position).toBe('absolute');
    expect(row('a')?.style.zIndex).toBe('-1');
    expect(row('b')?.style.position).toBe('');
    await waitFor(() => expect(row('a')).toBeNull());
    expect(row('b')).not.toBeNull();
  });

  it('退场途中同一个 key 又加回来：回到文档流；再删掉时按现在的位置重新量（FA5-CR-low A1）', async () => {
    let top = 10;
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get: () => top });
    try {
      render(<Harness start={['a', 'b']} />);
      act(() => setIds(['b']));
      expect(row('a')?.style.top).toBe('10px');
      act(() => setIds(['a', 'b']));
      expect(row('a')?.dataset['state']).not.toBe('leaving');
      expect(row('a')?.style.position).toBe('');
      top = 50;
      act(() => setIds(['b']));
      expect(row('a')?.style.position).toBe('absolute');
      expect(row('a')?.style.top).toBe('50px');
      await waitFor(() => expect(row('a')).toBeNull());
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, 'offsetTop', desc);
    }
  });

  it('列表外壳是定位元素（离开的那一项按它定位），并自成层叠上下文（离开那一项的 z-index -1 不掉到外层底色下面）', () => {
    render(<Harness start={['a']} />);
    expect(screen.getByTestId('list').style.position).toBe('relative');
    expect(screen.getByTestId('list').style.isolation).toBe('isolate');
  });

  it('参数：进场、收拢 --dur-ui；退场只淡出、--dur-ui 的一半、--ease-out，马上开始（N1）；收拢晚 LIST_LAYOUT_LAG（第三轮 P1）；进场晚 --dur-ui 的一半 + LIST_LAYOUT_LAG（M2、L1）', () => {
    const p = itemMotion(false);
    expect(p.initial).toEqual({ opacity: 0 });
    expect(p.animate).toEqual({ opacity: 1 });
    expect(p.transition).toMatchObject({ duration: dur.ui, layout: { ...tr.ui, delay: LIST_LAYOUT_LAG } });
    // 收拢晚两帧（≈ 33 ms，由 --dur-ui 推出，第三轮 P1）；新行等待同步加上
    expect(LIST_LAYOUT_LAG).toBeCloseTo(0.033, 6);
    expect(p.transition.delay).toBeCloseTo(dur.ui / 2 + LIST_LAYOUT_LAG, 6);
    expect(p.exit).toEqual({ opacity: 0, transition: { duration: dur.ui / 2, ease: ease.out } });
    expect('delay' in p.exit.transition).toBe(false);
  });

  it('减少动态效果：只淡入淡出、进场时长减半、不等；收拢不加延迟；退场同样 --dur-ui 的一半（不再减半）', () => {
    const rm = itemMotion(true);
    expect(rm.initial).toEqual({ opacity: 0 });
    expect('transform' in rm.exit).toBe(false);
    expect(rm.transition.duration).toBe(dur.ui / 2);
    expect(rm.transition.delay).toBe(0);
    expect(rm.transition.layout).toEqual(tr.ui);
    expect(rm.exit.transition.duration).toBe(dur.ui / 2);
  });
});
