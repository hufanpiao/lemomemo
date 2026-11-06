// 动效测试共用的假时钟推帧（MOTION-test-helper，11-05；原来在 appear-transform-end、features-async-cold-list 两个测试里各写一份）。
// • 假时钟只换定时器、performance.now、Date（FAKE）：“关了 100 ms 再开”是动画时间轴上的 100 ms，机器忙时取样间隔不会被拉长（MOTION-n1-load-flaky）。
// • 帧要显式推：Motion 在模块加载时就把真的 requestAnimationFrame 存下来了（motion-dom frameloop/frame.mjs），useFakeTimers 换掉全局 rAF
//   也管不到它，帧其实跟着 jsdom 的真实 rAF 走；机器一忙真实帧来得慢，假时钟推满 3000 ms 时 Motion 可能一帧都没处理
//   （2b65b43 CI 挂过“推了 3000 ms 动画时间还没到”）。所以每推一步都调 processFrame()（Motion 自带的手动推帧，时间戳取假的 performance.now），
//   每步至少处理一帧。副本里把真实 rAF 放慢到 200 ms 一帧能稳定复现旧问题，用这里的推法照样通过。
//   ⚠ 真实 rAF 多来的那一帧并非无害（11-06 更正）：它拿的是上一步的假时间，落在“播完那一步刷完、下一步推时间之前”会让 Appear 卡在
//   translateY(0%) scale(1)。所以用假时钟的测试还要配 ./raf-gate.ts（第一个 import 引它，useFakeTimers 后 hold()，切回真定时器后 release()）
import { act } from '@testing-library/react';
import { processFrame } from 'motion/react';
import { expect, vi } from 'vitest';

/** vi.useFakeTimers({ toFake: [...FAKE] }) 用的名单 */
export const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] as const;
export const FRAME_MS = 16;

/** 假时钟往前推 ms，再让 Motion 处理一帧 */
export const step = (ms: number = FRAME_MS): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    processFrame();
    // 让出一次真实宏任务（11-05，CI 在首尔、洛杉矶两遍各红过一次 appear-transform-end N1，和时区无关，是负载下的偶发）：
    // Appear 播完时 onAnimationComplete 里的 setState 有时落在 act 之外，交给 React Scheduler 用真实 setImmediate 排；
    // 不让出的话这次重画和下一帧（播完后的 transitionEnd: none）谁先谁后看机器忙不忙，后到时外层停在 translateY(0%) scale(1)。
    // 浏览器里重画总在下一帧之前，这里每帧之后等一次 setImmediate（先排的先跑），顺序就固定成和浏览器一样。
    // 副本里 40 份并发：改前 240 次文件运行红 2 次，改后 480 次 0 次
    await new Promise<void>((ok) => setImmediate(ok));
  });

/** 按帧推满 ms 动画时间 */
export async function fakeWait(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += FRAME_MS) await step(Math.min(FRAME_MS, ms - t));
}

/** 按帧往前推，直到 cond 成立（最多 limitMs 动画时间）；what 写进失败信息 */
export async function until(cond: () => boolean, what = '', limitMs = 3000): Promise<void> {
  for (let t = 0; t < limitMs && !cond(); t += FRAME_MS) await step();
  expect(cond(), `推了 ${limitMs} ms 动画时间还没到${what ? `：${what}` : ''}`).toBe(true);
}

/** 用过假时钟的用例收尾：切回真定时器之前把排着的帧推完（这一帧要是留在假时钟里被丢掉，之后的用例里 Motion 就再也不走了） */
export async function drainAndRestore(): Promise<void> {
  if (!vi.isFakeTimers()) return;
  for (let i = 0; i < 400 && vi.getTimerCount() > 0; i++) await step();
  vi.useRealTimers();
}
