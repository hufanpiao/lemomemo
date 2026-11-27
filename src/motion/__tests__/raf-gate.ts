// 假时钟用例里冻住 Motion 的真实帧（MOTION-n1-raf-gate，11-06 CI 69659c1 UTC 那遍 appear-transform-end sheet N1 第 103 行“推了 3000 ms 还没到”）。
// • 为什么要冻：Motion 加载时存下的是 jsdom 的 requestAnimationFrame。前面真定时器用例留下的那一帧走 Node 的真实 16 ms 定时器，
//   什么时候到看机器忙不忙；它到的时候 performance.now() 还是上一步的假时间，等于多出一帧和上一帧同一时间戳的帧。
//   要是正好落在“进场（或退场）播完那一步的 act 刷完之后、下一步推时间之前”，外层就停在 translateY(0%) scale(1)，
//   transitionEnd 的 none 再也上不去。整段一两百步的真实时间只有十几毫秒，落在哪一步基本是抽签。
//   浏览器里两帧不会同一时间戳，这是测试环境自己造出来的。副本里把这一帧压到第 K 步才放：改前 sheet 第 25、55 步，toast 第 14、15 步必挂，冻住以后全过。
// • 用法：测试文件**第一个 import** 引这个模块（要在任何引到 motion/react 的模块之前求值，Motion 才会存下这道闸）；
//   vi.useFakeTimers 之后 rafGate.hold()，切回真定时器以后 rafGate.release()。
//   hold() 期间 Motion 要的帧先存着、已经交给 jsdom 的帧撤回来，帧只由 fake-frames.ts 的 processFrame() 在 act 里推；
//   release() 把存着的帧交还 jsdom，后面真定时器的用例照常走。
// • rafGate.requests()：Motion 一共经闸要过几次帧。用例里断言它大于 0，确认 Motion 存下的确实是这道闸（引入顺序错了会直接红，不会悄悄回到抽签）

const realRaf = globalThis.requestAnimationFrame.bind(globalThis);
const realCaf = globalThis.cancelAnimationFrame.bind(globalThis);
let held = false;
let nextId = 1;
let requests = 0;
/** 冻住期间 Motion 要的帧 */
const waiting = new Map<number, FrameRequestCallback>();
/** 已经交给 jsdom、还没到的帧：自己的编号 → [jsdom 的编号, 回调] */
const live = new Map<number, [number, FrameRequestCallback]>();

function toReal(id: number, cb: FrameRequestCallback): void {
  live.set(id, [
    realRaf((ts) => {
      live.delete(id);
      cb(ts);
    }),
    cb,
  ]);
}

globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  const id = nextId++;
  requests++;
  if (held) waiting.set(id, cb);
  else toReal(id, cb);
  return id;
};

globalThis.cancelAnimationFrame = (id: number): void => {
  waiting.delete(id);
  const r = live.get(id);
  if (r) {
    realCaf(r[0]);
    live.delete(id);
  }
};

export const rafGate = {
  /** 冻住：之后的帧只由 processFrame 推 */
  hold(): void {
    held = true;
    for (const [id, [realId, cb]] of live) {
      realCaf(realId);
      waiting.set(id, cb);
    }
    live.clear();
  },
  /** 解冻：存着的帧交还 jsdom（切回真定时器以后调） */
  release(): void {
    if (!held) return;
    held = false;
    const w = [...waiting];
    waiting.clear();
    for (const [id, cb] of w) toReal(id, cb);
  },
  /** Motion 一共经闸要过几次帧 */
  requests: (): number => requests,
};
