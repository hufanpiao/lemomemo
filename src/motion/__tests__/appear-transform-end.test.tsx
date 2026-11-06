// Appear 进场播完以后外层不再带 transform（FA5-CR，前端 B 接线发现）：停在 translateY(0) scale(1) 的祖先会成为
// position: fixed 子元素的定位参照，横幅、按钮条会跑到页面中间。减少动态效果时同样成立。
// 停稳以后的退场：从“原位”起播到退场终点（不从 none 起播，Motion 会把 none 换成全零变换，scale 变成 0）
// 第一个引：要在引到 motion/react 的模块之前把 rAF 换成闸（原因见 raf-gate.ts）
import { rafGate } from './raf-gate.ts';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appearMotion } from '../Appear.tsx';
import { Appear } from '../components.ts';
import { presets, type AppearKind } from '../presets.ts';
import { loadMotionFeatures } from '../features.ts';
import { drainAndRestore, FAKE, fakeWait, until } from './fake-frames.ts';

// 动效功能包异步加载（B2 FA-6 ②）：这里测的是功能包到了以后的手感，先等它到
await loadMotionFeatures();

afterEach(async () => {
  // 用过假时钟的用例：切回真定时器之前先把排着的帧推完（fake-frames.ts），再把冻住的真实帧交还 jsdom
  await drainAndRestore();
  rafGate.release();
  cleanup();
  delete document.documentElement.dataset['rm'];
});

const outer = (c: HTMLElement, kind: AppearKind) => c.querySelector<HTMLElement>(`[data-appear="${kind}"]`);

describe('Appear 播完清掉 transform', () => {
  for (const kind of ['toast', 'sheet', 'popover', 'page', 'scrim', 'row'] as const) {
    it(`${kind}：进场播完后外层 transform 是 none（fixed 子元素按视口定位）`, async () => {
      const { container } = render(
        <Appear kind={kind} show>
          <div style={{ position: 'fixed' }}>x</div>
        </Appear>,
      );
      await waitFor(() => expect(outer(container, kind)?.style.transform).toBe('none'), { timeout: 3000 });
      expect(Number(outer(container, kind)?.style.opacity || '1')).toBe(1);
    });
  }

  it('减少动态效果（data-rm="1"）：播完后外层也没有 transform', async () => {
    document.documentElement.dataset['rm'] = '1';
    const { container } = render(
      <Appear kind="toast" show>
        <div>x</div>
      </Appear>,
    );
    await waitFor(() => expect(Number(outer(container, 'toast')?.style.opacity)).toBe(1), { timeout: 3000 });
    expect(['', 'none']).toContain(outer(container, 'toast')?.style.transform);
  });

  it('参数：进场目标带 transitionEnd transform none；停稳后的退场是“原位 → 退场终点”两段关键帧，时长曲线不变', () => {
    for (const kind of ['toast', 'sheet', 'popover', 'page', 'scrim', 'row'] as const) {
      const p = presets[kind];
      const before = appearMotion(kind, false);
      const after = appearMotion(kind, false, true);
      expect(before.animate).toEqual({ ...p.animate, transitionEnd: { transform: 'none' } });
      // 停稳以后目标就是 none（N2）：none → none 不插值
      expect(after.animate).toEqual({ opacity: p.animate.opacity, transform: 'none' });
      // 没停稳（进场中途退场）：照旧从当前值起播
      expect((before.exit as { transform?: unknown }).transform).toBe(p.exit.transform);
      expect((after.exit as { transform?: unknown }).transform).toEqual([p.animate.transform, p.exit.transform]);
      expect(after.exit.opacity).toBe(p.exit.opacity);
      expect(after.exit.transition).toEqual(before.exit.transition);
      expect(after.transition).toEqual(before.transition);
      // 减少动态效果：不带 transform，停没停稳都一样
      expect(appearMotion(kind, true, true)).toEqual(appearMotion(kind, true, false));
    }
  });

  it('停稳后退场：transform 从原位走到退场终点，途中没有 scale(0)，播完才卸载', async () => {
    const seen: string[] = [];
    const view = (show: boolean) => (
      <Appear kind="toast" show={show}>
        <div>x</div>
      </Appear>
    );
    const { container, rerender } = render(view(true));
    await waitFor(() => expect(outer(container, 'toast')?.style.transform).toBe('none'), { timeout: 3000 });
    const el = outer(container, 'toast') as HTMLElement;
    const mo = new MutationObserver(() => seen.push(el.style.transform));
    mo.observe(el, { attributes: true, attributeFilter: ['style'] });
    rerender(view(false));
    await waitFor(() => expect(el.isConnected).toBe(false), { timeout: 3000 });
    mo.disconnect();
    expect(seen.some((t) => t.startsWith('translateY('))).toBe(true);
    expect(seen.some((t) => /scale\(0(\.0+)?\)/.test(t))).toBe(false);
  });

  /** 解出 translateY 的数（px 或 %）；none、空当 0 */
  const ty = (t: string): number => {
    const m = /translateY\((-?[\d.]+)(px|%)\)/.exec(t);
    return m ? Number(m[1]) : 0;
  };
  // 假时钟推帧（FAKE、fakeWait、until）在 fake-frames.ts，原因见那边的文件头
  /** 真实时间等 ms（下面几条减少动态效果的用例用真定时器） */
  const wait = (ms: number) => act(() => new Promise<void>((ok) => setTimeout(ok, ms)));
  for (const kind of ['sheet', 'toast'] as const) {
    it(`${kind}：停稳 → 关 → 退场途中又开 → 没播完又关（FA-5 复审 N1）：第二次退场一路往终点走，不闪回原位`, async () => {
      const view = (show: boolean) => (
        <Appear kind={kind} show={show}>
          <div>x</div>
        </Appear>
      );
      vi.useFakeTimers({ toFake: [...FAKE] });
      // 帧只由 processFrame 推（见 raf-gate.ts）
      rafGate.hold();
      const { container, rerender } = render(view(true));
      // 确认 Motion 存下的是这道闸、不是别处的 rAF（不然冻不住，又回到抽签）：前面的用例里它经闸要过帧
      expect(rafGate.requests(), 'Motion 没经过 rafGate 要帧').toBeGreaterThan(0);
      await until(() => outer(container, kind)?.style.transform === 'none');
      const el = outer(container, kind) as HTMLElement;
      rerender(view(false));
      await fakeWait(100);
      rerender(view(true));
      // toast 的位移只有 12px：重开后早一点关，让关之前的位移够大，闪回原位才和“沿进场方向多走一帧”分得开
      await fakeWait(kind === 'toast' ? 20 : 60);
      expect(el.isConnected).toBe(true);
      const before = ty(el.style.transform);
      expect(before, '重新进场还没播完').toBeGreaterThan(0);
      // 逐条记每次写 style 之后的值：回调里读 el.style 只看得到同一批里最后一次，同一帧里“先跳回原位再走”会漏掉。
      // 每条记录的 oldValue 是这次改之前的值，所以第 i 次改之后的值 = 第 i+1 条的 oldValue，最后一次 = 卸载前的 style
      const olds: (string | null)[] = [];
      const mo = new MutationObserver((rs) => {
        for (const r of rs) olds.push(r.oldValue);
      });
      mo.observe(el, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
      let last = '';
      const tail = new MutationObserver(() => {
        last = el.getAttribute('style') ?? '';
      });
      tail.observe(el, { attributes: true, attributeFilter: ['style'] });
      rerender(view(false));
      await until(() => !el.isConnected);
      mo.disconnect();
      tail.disconnect();
      const styleTy = (st: string | null): number => {
        const t = /transform:\s*([^;]+)/.exec(st ?? '')?.[1] ?? '';
        return ty(t);
      };
      const seen = [...olds.slice(1), last].map(styleTy);
      expect(seen.length).toBeGreaterThan(2);
      const seq = seen.map((v) => v.toFixed(2)).join(', ');
      // 开头可能还有关之前已经排好的那一帧进场（Motion 下一帧才起退场；第一次进场没播完就关也一样，是复审认可的那条路，
      // 实测 sheet 13.06 → 10.87 → 15.92 …）：最低点之前只许沿进场方向小走一点，不能掉到关之前的一半以下。
      // 闪回原位的旧问题：sheet 33.4% → 0.9%、toast 1.30px → 0px
      const low = seen.indexOf(Math.min(...seen));
      expect(seen[low], `闪回原位了：关之前 ${before}，序列 ${seq}`).toBeGreaterThan(before / 2);
      for (let i = 1; i <= low; i++) expect(seen[i], `退场前又往回走了：${seq}`).toBeLessThanOrEqual((seen[i - 1] ?? 0) + 0.01);
      // 过了最低点一路往退场终点走：单调不减
      for (let i = low + 1; i < seen.length; i++) expect(seen[i], `第 ${i} 帧往回跳了：${seq}`).toBeGreaterThanOrEqual((seen[i - 1] ?? 0) - 0.01);
      expect(seen.at(-1)).toBe(kind === 'sheet' ? 100 : 12);
    });
  }

  it('减少动态效果开了又关（N2）：停稳的外层不从 scale(0) 放大，transform 一直是 none', async () => {
    const { container } = render(
      <Appear kind="popover" show>
        <div>x</div>
      </Appear>,
    );
    await waitFor(() => expect(outer(container, 'popover')?.style.transform).toBe('none'), { timeout: 3000 });
    const el = outer(container, 'popover') as HTMLElement;
    const seen: string[] = [];
    const mo = new MutationObserver(() => seen.push(el.style.transform));
    mo.observe(el, { attributes: true, attributeFilter: ['style'] });
    act(() => {
      document.documentElement.dataset['rm'] = '1';
    });
    await wait(300);
    act(() => {
      delete document.documentElement.dataset['rm'];
    });
    await wait(400);
    mo.disconnect();
    expect(seen.filter((t) => /scale\(/.test(t)), seen.join(', ')).toEqual([]);
    expect(['', 'none']).toContain(el.style.transform);
  });

  it('在减少动态效果下挂上、之后关掉减少动态效果（N2，HEAD 版的旧问题）：不从 scale(0) 放大', async () => {
    document.documentElement.dataset['rm'] = '1';
    const { container } = render(
      <Appear kind="popover" show>
        <div>x</div>
      </Appear>,
    );
    await waitFor(() => expect(Number(outer(container, 'popover')?.style.opacity)).toBe(1), { timeout: 3000 });
    await wait(100);
    const el = outer(container, 'popover') as HTMLElement;
    const seen: string[] = [];
    const mo = new MutationObserver(() => seen.push(el.style.transform));
    mo.observe(el, { attributes: true, attributeFilter: ['style'] });
    act(() => {
      delete document.documentElement.dataset['rm'];
    });
    await wait(400);
    mo.disconnect();
    expect(seen.filter((t) => /scale\(/.test(t)), seen.join(', ')).toEqual([]);
    expect(['', 'none']).toContain(el.style.transform);
  });
});
