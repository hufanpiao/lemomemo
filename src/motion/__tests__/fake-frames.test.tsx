// fake-frames.ts 推帧法的回归测试（代码审查 D2，11-05）：Motion 在模块加载时存下真实的 requestAnimationFrame，
// 假时钟管不到它。这里在 Motion 加载前把真实 rAF 换成“攒着不放”（模拟 CI 机器忙到极致：放慢到 200 ms 一帧的极限情形），
// 推帧全靠 step() 里的 processFrame()。删掉 processFrame 时：假时钟推满 3000 ms 动画时间，Motion 一帧也跑不了，Appear 播不完，这条稳定变红。
// 不用“真 setTimeout 200 ms 一帧”（第一版）：满载并行时推帧循环本身就要好几秒墙钟时间，真实帧会漏进来，
// “真实帧少于 5 帧”的自检跟着墙钟走，偶发变红（代码审查 11-05）。攒着不放以后，自检是“这期间真实帧为 0”，和机器快慢无关
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted 先于下面所有 import 执行：Motion（frame.mjs）加载时存下的就是这个攒着不放的 rAF。
// 它不靠任何定时器，之后 useFakeTimers 换掉全局定时器也碰不到它
const slow = vi.hoisted(() => {
  const orig = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  const held = new Map<number, FrameRequestCallback>();
  let next = 1;
  let fired = 0;
  let asked = 0;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    asked++;
    held.set(next, cb);
    return next++;
  };
  globalThis.cancelAnimationFrame = (id: number): void => {
    held.delete(id);
  };
  /** 用例收尾：把攒着的回调放掉（Motion 之后的帧照常排队） */
  const release = (): void => {
    const cbs = [...held.values()];
    held.clear();
    for (const cb of cbs) {
      fired++;
      cb(performance.now());
    }
  };
  return { orig, frames: () => fired, asked: () => asked, release };
});

const { Appear } = await import('../components.ts');
const { loadMotionFeatures } = await import('../features.ts');
const { drainAndRestore, FAKE, until } = await import('./fake-frames.ts');

await loadMotionFeatures();

afterEach(async () => {
  await drainAndRestore();
  cleanup();
  slow.release();
});

afterAll(() => {
  globalThis.requestAnimationFrame = slow.orig.raf;
  globalThis.cancelAnimationFrame = slow.orig.caf;
});

describe('fake-frames：真实 rAF 攒着不放，推帧照样走', () => {
  for (const kind of ['toast', 'sheet', 'page'] as const) {
    // 188 步推帧在满载并行时要好几秒墙钟时间，超时放宽到 20 秒（判据是动画时间，不是墙钟）
    it(`${kind}：3000 ms 动画时间内播完（外层 transform 变 none）`, { timeout: 20_000 }, async () => {
      vi.useFakeTimers({ toFake: [...FAKE] });
      const before = slow.frames();
      const askedBefore = slow.asked();
      const { container } = render(
        <Appear kind={kind} show>
          <div>x</div>
        </Appear>,
      );
      const el = () => container.querySelector<HTMLElement>(`[data-appear="${kind}"]`);
      await until(() => el()?.style.transform === 'none', `${kind} 进场`, 3000);
      expect(Number(el()?.style.opacity || '1')).toBe(1);
      // 自检（代码审查 FA-7 第八节 L10）：这期间 Motion 确实向真实 rAF 要过帧（被攒住了），而真实帧一帧都没放，
      // 播完全靠 processFrame（和机器快慢无关）。只断言“没放”在运行期间恒为真，起不到检查作用
      expect(slow.asked() - askedBefore).toBeGreaterThan(0);
      expect(slow.frames() - before).toBe(0);
    });
  }
});
