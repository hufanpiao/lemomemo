// 动效功能包异步加载（B2 FA-6 ②，src/motion/features.ts）和退场 inert（接手清单 MOTION-leaving-inert）：
// • 功能包还没到时挂上的 Appear、新加进列表的行：直接画成停稳的样子（不透明、transform: none），不停在 initial 的透明里；
//   列表行不打 data-state="entering"、照常接点按
// • 功能包到了以后新挂上的：照常从 initial 播入场，播完 transform 清成 none（新 LazyMotion 拿同步的包，不再等一轮 then）
// • 没到时挂上的（门面画的静态，R-354）：这一次显示期间不换实现，关掉当场移除；下次打开交给动画实现，退场照常播（data-state="leaving"）
// • 退场期间外层带 inert（键盘、读屏碰不到）；没在退场时不带
// • 只下载一次；下载失败不抛，下一次再试（另见 features-retry.test.ts）
// 注意：本文件依赖用例顺序（K8-newItem 重构 M6 复审 L2，11-05）。功能包的“下载完”是模块级的 gate，只开一次，
//   “还没到”的用例必须排在开 gate 的用例前面；打乱顺序（--sequence.shuffle）会红，改动前的旧版同样会红，不是假时钟带进来的。
//   加用例时照现有顺序放；要单独跑某一条，连同它前面的用例一起跑
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
vi.mock('../motion-impl.tsx', async (importOriginal) => {
  gate.loads += 1;
  await gate.ready;
  // 动画实现和功能包合成一块（R-354）：等闸开了再给真的那一块
  return await importOriginal();
});

const { Appear, AppearItem, AppearList } = await import('../components.ts');
const { loadMotionFeatures, motionFeatures, motionFeaturesReady } = await import('../features.ts');
// 假时钟推帧（FAKE、fakeWait、until）在 fake-frames.ts，原因见那边的文件头
const { drainAndRestore, FAKE, fakeWait, until } = await import('./fake-frames.ts');

afterEach(async () => {
  // 用过假时钟的用例：切回真定时器之前先把排着的帧推完（fake-frames.ts）
  await drainAndRestore();
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
  it('没到时挂上的弹层（门面画的静态）：到了以后按停稳换成实现，关掉有退场；再打开从 initial 播入场，关时照常播退场（leaving、带 inert）', async () => {
    // R-354 M1（负责人选“修掉”）：已显示的这一条在守卫通过时按“已停稳”换成实现（DOM 一样），关掉照常有退场
    // 时间走假时钟、按帧推（代码审查 K8-newItem 重构 M6）
    vi.useFakeTimers({ toFake: [...FAKE] });
    const view = (show: boolean) => (
      <Appear kind="sheet" show={show}>
        <button type="button">ok</button>
      </Appear>
    );
    const { container, rerender } = render(view(true));
    const cold = box(container, 'sheet');
    expect(motionFeaturesReady()).toBe(false);
    gate.open();
    await act(async () => {
      await loadMotionFeatures();
    });
    expect(motionFeaturesReady()).toBe(true);
    await fakeWait(20);
    const swapped = box(container, 'sheet');
    expect(swapped, '守卫通过，换成实现（重挂）').not.toBe(cold);
    expect(swapped?.getAttribute('style'), '按停稳挂上，看不出来').toBe(cold?.getAttribute('style'));
    rerender(view(false));
    expect(box(container, 'sheet')?.dataset['state'], '换上以后关掉有退场').toBe('leaving');
    await fakeWait(600);
    expect(box(container, 'sheet'), '退场播完移除').toBeNull();
    // 再打开：动画实现已经到了，从 initial 播入场
    rerender(view(true));
    await until(() => box(container, 'sheet')?.style.transform === 'none', '入场播完 transform 清成 none');
    rerender(view(false));
    const el = box(container, 'sheet');
    expect(el?.dataset['state']).toBe('leaving');
    expect(el?.hasAttribute('inert'), '退场期间键盘也碰不到（MOTION-leaving-inert）').toBe(true);
    // 退场从“原位”起播：不能从 none（= 全零变换）起播，那样 scale 会从 0 放大
    const seen: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      await fakeWait(12);
      seen.push(box(container, 'sheet')?.style.transform ?? '');
    }
    for (const tf of seen) {
      const k = /scale\(([\d.]+)\)/.exec(tf)?.[1];
      if (k !== undefined) expect(Number(k), `退场途中缩放了：${tf}`).toBe(1);
    }
    expect(seen.some((tf) => tf.startsWith('translateY(')), '退场在往下滑').toBe(true);
    await until(() => box(container, 'sheet') === null, '退场播完卸载');
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
