// usage-report 的单项计时读取：心跳部分的旁路读取（core.ts 的 SIDES）和用量部分（usage.ts）共用这一份。
// 不 import npm 包、不碰 Deno 全局。

const TIMED_OUT = Symbol('timeout');

/**
 * 开始一项读取，单独计时：done 一定 resolve（出错、超时、数字不对都给 null，只记错误码 `${tag}:…`）。
 * pick 校验读到的值：out 为 null 表示不对，code 是要记的错误码。
 * stop()：整轮已经失败（503 / 500）时调用，中止读取、清掉计时器，之后不再记任何日志。
 */
export function startSide<R, O>(
  read: (signal: AbortSignal) => Promise<R>,
  ms: number,
  tag: string,
  pick: (r: unknown) => { out: O | null; code?: string },
  log?: (code: string) => void,
) {
  const ctl = new AbortController();
  let quiet = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const say = (code: string) => {
    if (!quiet) log?.(code);
  };
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      // 先记“超时”再中止：读取方收到 abort 立刻拒绝时，记的仍是 timeout、不是 error
      timedOut = true;
      resolve(TIMED_OUT);
      ctl.abort();
    }, ms);
  });
  const done = (async (): Promise<O | null> => {
    try {
      const r: unknown = await Promise.race([read(ctl.signal), timeout]);
      if (r === TIMED_OUT) {
        say(`${tag}:timeout`);
        return null;
      }
      const { out, code } = pick(r);
      if (code !== undefined) say(code);
      return out;
    } catch {
      say(timedOut ? `${tag}:timeout` : `${tag}:error`);
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  })();
  return {
    done,
    stop() {
      quiet = true;
      if (timer !== undefined) clearTimeout(timer);
      ctl.abort();
    },
  };
}
