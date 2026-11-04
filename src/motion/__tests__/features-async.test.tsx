// 动效功能包异步加载（B2 FA-6 ②，src/motion/features.ts）和退场 inert（接手清单 MOTION-leaving-inert）：
// • 功能包还没到时挂上的 Appear、新加进列表的行：直接画成停稳的样子（不透明、transform: none），不停在 initial 的透明里；
//   列表行不打 data-state="entering"、照常接点按
// • 功能包到了以后新挂上的：照常从 initial 播入场，播完 transform 清成 none（新 LazyMotion 拿同步的包，不再等一轮 then）
// • 没到时挂上、到了以后才关：退场照常播（data-state="leaving"），播完才卸载
// • 退场期间外层带 inert（键盘、读屏碰不到）；没在退场时不带
// • 只下载一次；下载失败不抛，下一次再试（另见 features-retry.test.ts）
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { presets } from '../presets.ts';

// 功能包那一块：测试来决定什么时候“下载完”
const gate = vi.hoisted(() => {
  let open!: () => void;
  const ready = new Promise<void>((ok) => (open = ok));
  return { ready, open: () => open(), loads: 0 };
});
vi.mock('../feature-bundle.ts', async () => {
  gate.loads += 1;
  await gate.ready;
  const { domMax } = await import('motion/react');
  return { default: domMax };
});

const { Appear, AppearItem, AppearList } = await import('../components.ts');
const { loadMotionFeatures, motionFeatures, motionFeaturesReady } = await import('../features.ts');

afterEach(() => {
  cleanup();
});

const box = (c: HTMLElement, kind: string) => c.querySelector<HTMLElement>(`[data-appear="${kind}"]`);
const wait = (ms: number) => act(() => new Promise<void>((ok) => setTimeout(ok, ms)));

function List({ ids }: { ids: string[] }) {
  return (
    <AppearList as="ul" data-testid="list">
      {ids.map((id) => (
        <AppearItem key={id} as="li" data-id={id}>
          {id}
        </AppearItem>
      ))}
    </AppearList>
  );
}

// 这几条按顺序跑：前两条在功能包到之前，后面在到了以后（模块里的状态是共用的）
describe('功能包还没到', () => {
  it('Appear 挂上就是停稳的样子：不透明、transform: none；不算退场，不带 inert', async () => {
    expect(motionFeaturesReady()).toBe(false);
    const { container } = render(
      <Appear kind="sheet" show>
        <button type="button">ok</button>
      </Appear>,
    );
    const el = box(container, 'sheet');
    expect(el).not.toBeNull();
    expect(el?.style.opacity, '不能停在 initial 的透明里').not.toBe('0');
    expect(el?.style.transform).toBe('none');
    expect(el?.hasAttribute('inert')).toBe(false);
    await wait(50);
    expect(el?.style.opacity).not.toBe('0');
  });

  it('列表第一次画出以后新加的一行：直接显示，不打 entering、不挡点按', async () => {
    const { container, rerender } = render(<List ids={['a']} />);
    rerender(<List ids={['a', 'b']} />);
    const b = container.querySelector<HTMLElement>('[data-id="b"]');
    expect(b).not.toBeNull();
    expect(b?.dataset['state']).not.toBe('entering');
    expect(b?.style.pointerEvents).not.toBe('none');
    expect(b?.style.opacity, '不能停在 opacity 0').not.toBe('0');
  });
});

describe('功能包到了以后', () => {
  it('没到时挂上的弹层，到了以后关：照常播退场（leaving、带 inert），播完才卸载', async () => {
    const view = (show: boolean) => (
      <Appear kind="sheet" show={show}>
        <button type="button">ok</button>
      </Appear>
    );
    const { container, rerender } = render(view(true));
    expect(motionFeaturesReady()).toBe(false);
    gate.open();
    await act(async () => {
      await loadMotionFeatures();
    });
    expect(motionFeaturesReady()).toBe(true);
    await wait(20);
    rerender(view(false));
    const el = box(container, 'sheet');
    expect(el?.dataset['state']).toBe('leaving');
    expect(el?.hasAttribute('inert'), '退场期间键盘也碰不到（MOTION-leaving-inert）').toBe(true);
    // 退场从“原位”起播（没到时挂上的算已停稳）：不能从 none（= 全零变换）起播，那样 scale 会从 0 放大
    const seen: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      await wait(12);
      seen.push(box(container, 'sheet')?.style.transform ?? '');
    }
    for (const tf of seen) {
      const k = /scale\(([\d.]+)\)/.exec(tf)?.[1];
      if (k !== undefined) expect(Number(k), `退场途中缩放了：${tf}`).toBe(1);
    }
    expect(seen.some((tf) => tf.startsWith('translateY(')), '退场在往下滑').toBe(true);
    expect(box(container, 'sheet'), '退场在播，还没卸载').not.toBeNull();
    await waitFor(() => expect(box(container, 'sheet')).toBeNull(), { timeout: 3000 });
  });

  it('只下载一次；之后给 LazyMotion 的是包本身（同步装上）', () => {
    expect(gate.loads).toBe(1);
    expect(loadMotionFeatures(), '再调也是同一次下载').toBe(loadMotionFeatures());
    expect(typeof motionFeatures()).toBe('object');
  });

  it('到了以后新挂上的 Appear：从 initial 起播入场，播完 transform 清成 none', async () => {
    const { container } = render(
      <Appear kind="sheet" show>
        <div>x</div>
      </Appear>,
    );
    const el = box(container, 'sheet');
    expect(el?.style.opacity, '从 initial 起播').toBe(String(presets.sheet.initial.opacity));
    await waitFor(() => expect(el?.style.transform).toBe('none'), { timeout: 3000 });
    expect(el?.style.opacity).toBe('1');
  });

  it('到了以后新加的行：照常淡入，播完前打 entering、不接点按', async () => {
    const { container, rerender } = render(<List ids={['a']} />);
    rerender(<List ids={['a', 'c']} />);
    const c = container.querySelector<HTMLElement>('[data-id="c"]');
    expect(c?.dataset['state']).toBe('entering');
    expect(c?.style.pointerEvents).toBe('none');
    await waitFor(() => expect(c?.dataset['state']).not.toBe('entering'), { timeout: 3000 });
  });

  it('退场 inert：显示着的不带，开始离开就带上，同一个弹层再打开又去掉', async () => {
    function Toggle() {
      const [show, setShow] = useState(true);
      return (
        <>
          <button type="button" data-testid="t" onClick={() => setShow((v) => !v)}>
            t
          </button>
          <Appear kind="toast" show={show}>
            <button type="button">x</button>
          </Appear>
        </>
      );
    }
    const { container, getByTestId } = render(<Toggle />);
    const el = () => box(container, 'toast');
    await waitFor(() => expect(el()?.style.transform).toBe('none'), { timeout: 3000 });
    expect(el()?.hasAttribute('inert')).toBe(false);
    act(() => getByTestId('t').click());
    expect(el()?.hasAttribute('inert')).toBe(true);
    act(() => getByTestId('t').click());
    expect(el()?.hasAttribute('inert'), '重新进场不再 inert').toBe(false);
    expect(el()?.dataset['state']).toBeUndefined();
  });
});
