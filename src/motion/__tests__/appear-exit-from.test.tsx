// Appear 退场从哪里起播（FA-5 复审 N1）：直接看每次渲染交给 Motion 的 exit 参数，不依赖 jsdom 里帧的先后
// （appear-transform-end.test.tsx 里看 DOM 位移的用例在旧代码上能不能看到“闪回原位”那一帧，取决于帧时序；这里是确定的）
// • 停稳以后关：exit 是两段关键帧“原位 → 退场终点”（transform 已清成 none，不能从 none 起播）
// • 停稳 → 关 → 退场途中又开 → 没播完又关：第二次 exit 从当前值起播（presets 的 exit），不是两段关键帧
// • 时间走假时钟、按帧推（fake-frames.ts；代码审查 K8-newItem 重构 M6）：原来用真 setTimeout 等 100 ms、30 ms，
//   并发跑时真实帧来得慢，“退场途中又开、还没播完”这一步会落到已经播完之后
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { m as MotionM } from 'motion/react';
import { presets } from '../presets.ts';
import { drainAndRestore, FAKE, fakeWait, until } from './fake-frames.ts';

const seen = vi.hoisted(() => ({ exits: [] as unknown[] }));
vi.mock('motion/react', async (importOriginal) => {
  const real = await importOriginal<{ m: typeof MotionM }>();
  const React = await import('react');
  type DivProps = React.ComponentProps<typeof real.m.div>;
  // 原样转给真的 m.div，只记下 exit 参数
  const Div = React.forwardRef<HTMLDivElement, DivProps>((props, ref) => {
    seen.exits.push(props.exit);
    return React.createElement(real.m.div, { ...props, ref });
  });
  Div.displayName = 'RecordExitDiv';
  return { ...real, m: new Proxy(real.m, { get: (t, k) => (k === 'div' ? Div : Reflect.get(t, k)) }) };
});

const { Appear } = await import('../components.ts');
const { loadMotionFeatures } = await import('../features.ts');
// 动效功能包异步加载（B2 FA-6 ②）：这里测的是功能包到了以后的退场起点，先等它到
await loadMotionFeatures();

afterEach(async () => {
  // 切回真定时器之前先把排着的帧推完（fake-frames.ts）
  await drainAndRestore();
  cleanup();
  seen.exits.length = 0;
});

const exitTransform = (e: unknown): unknown => (e as { transform?: unknown } | undefined)?.transform;

describe('Appear 退场的起点（FA-5 复审 N1，看 exit 参数）', () => {
  for (const kind of ['sheet', 'toast'] as const) {
    it(`${kind}：停稳后关是“原位 → 终点”；退场途中又开、没播完又关，第二次从当前值起播`, async () => {
      const p = presets[kind];
      const view = (show: boolean) => (
        <Appear kind={kind} show={show}>
          <div>x</div>
        </Appear>
      );
      vi.useFakeTimers({ toFake: [...FAKE] });
      const { container, rerender } = render(view(true));
      const el = () => container.querySelector<HTMLElement>(`[data-appear="${kind}"]`);
      await until(() => el()?.style.transform === 'none', '入场播完、transform 清成 none');
      seen.exits.length = 0;
      rerender(view(false));
      expect(exitTransform(seen.exits.at(-1))).toEqual([p.animate.transform, p.exit.transform]);
      await fakeWait(100);
      rerender(view(true));
      await fakeWait(30);
      expect(el()?.style.transform, '重新进场还没播完').not.toBe('none');
      seen.exits.length = 0;
      rerender(view(false));
      expect(seen.exits.length).toBeGreaterThan(0);
      for (const e of seen.exits) expect(exitTransform(e), '第二次退场不能从“原位”起播').toBe(p.exit.transform);
      await until(() => el() === null, '退场播完卸载');
      for (const e of seen.exits) expect(exitTransform(e)).toBe(p.exit.transform);
    });
  }
});
