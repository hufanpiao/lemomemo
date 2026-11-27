// 多标签页测试用的假 Web Locks、BroadcastChannel、可见性（platform/tab-leader.ts 的测试和 app 的接线测试共用；不是测试文件本身）
import type { ChannelLike, LocksLike } from '../tab-leader.ts';

/** 假的 Web Locks：同名排它锁，排队先来先得，signal abort 时撤掉排队 */
export function fakeLocks(): LocksLike & { holder(): string | null } {
  const queue: { id: string; cb: () => Promise<void>; done: (v: unknown) => void; fail: (e: unknown) => void }[] = [];
  let busy: string | null = null;
  let seq = 0;
  const pump = (): void => {
    if (busy !== null) return;
    const next = queue.shift();
    if (!next) return;
    busy = next.id;
    void next.cb().then(next.done, next.fail).finally(() => {
      busy = null;
      pump();
    });
  };
  return {
    holder: () => busy,
    request(_name, options, cb) {
      return new Promise((done, fail) => {
        const id = `w${++seq}`;
        const entry = { id, cb, done, fail };
        options.signal?.addEventListener('abort', () => {
          const i = queue.indexOf(entry);
          if (i >= 0) {
            queue.splice(i, 1);
            fail(new DOMException('aborted', 'AbortError'));
          }
        });
        queue.push(entry);
        pump();
      });
    },
  };
}

/** 假的 BroadcastChannel：同一个 bus 上的频道互相收得到，自己收不到 */
export function fakeBus(): (name: string) => ChannelLike {
  const all = new Set<ChannelLike>();
  return () => {
    const ch: ChannelLike = {
      onmessage: null,
      postMessage(m) {
        for (const o of all) if (o !== ch) queueMicrotask(() => o.onmessage?.({ data: m }));
      },
      close() {
        all.delete(ch);
      },
    };
    all.add(ch);
    return ch;
  };
}

export function fakeVisibility(visible = true) {
  const fns = new Set<(v: boolean) => void>();
  let v = visible;
  return {
    isVisible: () => v,
    onChange(fn: (visible: boolean) => void) {
      fns.add(fn);
      return () => fns.delete(fn) as unknown as void;
    },
    set(next: boolean) {
      v = next;
      fns.forEach((f) => f(next));
    },
  };
}
