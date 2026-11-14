// 同步的串行链：发送、拉取、Realtime 来的行、墓碑都排进一条链，一次只跑一件（engine.ts 用）
// • 跑之前、跑之后看闸，设上了就 onHalt（停下）
// • 活里抛 CacheClosedError（换账号、被移除时库被封存或关闭）：当作“停下”，不重试、不报错、不记日志（outbox-types.ts 的约定）
// • 别的错：记一个错误码（不记内容），链接着往下走，不抛
// • 看门狗：一件活超过 TASK_TIMEOUT_MS 还没完，不再等它，放行下一件并记 sync_task_timeout（K8 审查必改 1：
//   网络层已有 20 秒超时，这里是最后一道兜底，防止一件永不返回的活把整条链卡死）。
//   这条日志带上是哪件活（coll，排活时给的名字，如 pull、send、rt:events，只有表名、没有内容）和从开跑到看门狗真正触发的墙钟毫秒数
//   （code，ms=…）：预览库 11-12～11-14 记到 5 次却看不出是哪件、是真卡住还是 iPhone 把页面挂起、回前台才补触发的计时器
//   （真卡住约等于 60000，挂起过会远大于它），先补日志定根因，再决定要不要改成取消信号（第三方审查 后端-2）
// 纯 TS：不准 import React 和任何功能（A1）
import { CacheClosedError } from '../cache.ts';

/** 单件活最多等这么久（网络层每个请求 20 秒超时；一件活可能连着几个请求，给到 60 秒） */
export const TASK_TIMEOUT_MS = 60_000;

export interface Runner {
  /** 排一件活（what：给看门狗日志用的名字，只放表名一类，不放内容）；返回这件活跑完（或被跳过、或被看门狗放行）时 resolve 的 Promise，不 reject */
  run(task: () => Promise<void>, what?: string): Promise<void>;
  /** 链尾（还没排新活时就是最后一件） */
  tail(): Promise<void>;
  /** 等到链上不再有新排的活 */
  idle(): Promise<void>;
}

const TIMED_OUT = Symbol('timeout');

export function createRunner(
  gated: () => boolean,
  onHalt: () => void,
  log?: (act: string, f?: { coll?: string; code?: string }) => void,
  timeoutMs: number = TASK_TIMEOUT_MS,
): Runner {
  let chain: Promise<void> = Promise.resolve();
  /** 跑这件活，最多等 timeoutMs；超时返回 TIMED_OUT（活本身不取消，它的 Promise 以后完成也不影响链） */
  const guarded = (task: () => Promise<void>): Promise<void | typeof TIMED_OUT> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const dog = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    const work = Promise.resolve().then(task);
    work.catch(() => undefined);   // 超时以后才 reject 的，不留未处理的 rejection
    return Promise.race([work, dog]).finally(() => {
      if (timer !== null) clearTimeout(timer);
    });
  };
  return {
    run(task, what = 'task') {
      const p = chain.then(async () => {
        if (gated()) {
          onHalt();
          return;
        }
        const t0 = Date.now();
        try {
          if ((await guarded(task)) === TIMED_OUT) log?.('sync_task_timeout', { coll: what, code: `ms=${Date.now() - t0}` });
        } catch (e) {
          if (e instanceof CacheClosedError) {
            onHalt();
            return;
          }
          log?.('sync_error');
        }
        if (gated()) onHalt();
      });
      chain = p;
      return p;
    },
    tail: () => chain,
    async idle() {
      for (let last: Promise<void> | null = null; last !== chain; ) {
        last = chain;
        await last;
      }
    },
  };
}
