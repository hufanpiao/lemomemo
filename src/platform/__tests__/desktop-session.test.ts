// desktop.ts 的会话存储适配器和事件订阅（复核 N1；F4）：supabase-js 的 storage 接 Rust 的 session_get / session_set / session_remove，
// auth:done 以后 main 重新读会话。Rust 命令和 __TAURI_INTERNALS__ 都用假的。
// 会话键和 env.rs 的一致性、只读视图、真 supabase-js 退出登录在 desktop-session-signout.test.ts（按 W1 拆开）
import { describe, expect, it } from 'vitest';
import {
  createDesktopSessionStorage,
  desktopSessionStorage as rawStorage,
  onAuthDone,
  onQuickAddText,
  type TauriInternalsEvents,
} from '../desktop.ts';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 假的 Rust 会话命令：白名单 + 内存表；calls 记下每次调用 */
function fakeSessionInvoke(allowed = ['sb-lemomemo-auth-token', 'sb-lemomemo-auth-token-user']) {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    const key = String(args?.key);
    calls.push(`${cmd} ${key}`);
    await Promise.resolve();
    if (!allowed.includes(key)) throw 'key_not_allowed';
    if (cmd === 'session_get') return store.get(key) ?? null;
    if (cmd === 'session_set') store.set(key, String(args?.value));
    else if (cmd === 'session_remove') store.delete(key);
    else throw new Error(`unexpected ${cmd}`);
    return null;
  };
  return { store, calls, invoke };
}

const KEY = 'sb-lemomemo-auth-token';
const KEYS = [KEY, `${KEY}-user`];
type RawInvoke = Parameters<typeof rawStorage>[0];
/** 默认按正式版的两个键（和 env.rs 正式那套一样） */
const desktopSessionStorage = (invoke: RawInvoke, keys: readonly string[] = KEYS, opts?: { timeoutMs?: number }) => rawStorage(invoke, keys, opts);

describe('N1：exe 会话存储接 session_get / session_set / session_remove', () => {
  it('读写删都走 Rust 命令，参数是 { key, value }', async () => {
    const f = fakeSessionInvoke();
    const s = desktopSessionStorage(f.invoke);
    expect(await s.getItem(KEY)).toBeNull();
    await s.setItem(KEY, '{"access_token":"a"}');
    expect(f.store.get(KEY)).toBe('{"access_token":"a"}');
    expect(await s.getItem(KEY)).toBe('{"access_token":"a"}');
    await s.removeItem(KEY);
    expect(f.store.has(KEY)).toBe(false);
    expect(f.calls).toEqual([`session_get ${KEY}`, `session_set ${KEY}`, `session_get ${KEY}`, `session_remove ${KEY}`]);
  });

  it('名单外的键：读回 null、删直接算成功，都不调 Rust；写照样抛 key_not_allowed（M1、F5-1）', async () => {
    const f = fakeSessionInvoke();
    const s = desktopSessionStorage(f.invoke);
    await expect(s.getItem(`${KEY}-code-verifier`)).resolves.toBeNull();
    await expect(s.removeItem(`${KEY}-code-verifier`)).resolves.toBeUndefined();
    await expect(s.removeItem(`${KEY}-flows-code-verifier`)).resolves.toBeUndefined();
    await expect(s.setItem(`${KEY}-code-verifier`, 'x')).rejects.toBe('key_not_allowed');
    expect(f.calls).toEqual([]);
    expect(s.peek(`${KEY}-code-verifier`)).toBeUndefined();
  });

  it('名单里的键：读失败（本窗口不许读、Rust 出错、回的不是字符串）当没有，不抛错；写、删失败照样抛', async () => {
    const f = fakeSessionInvoke([]); // Rust 一侧全拒：模拟 auth 小窗口不许读、或凭据管理器出错
    const s = desktopSessionStorage(f.invoke);
    await expect(s.getItem(KEY)).resolves.toBeNull();
    await expect(s.setItem(KEY, 'x')).rejects.toBe('key_not_allowed');
    await expect(s.removeItem(KEY)).rejects.toBe('key_not_allowed');
    const odd = desktopSessionStorage(async () => 42);
    await expect(odd.getItem(KEY)).resolves.toBeNull();
    expect(odd.peek(KEY)).toBeNull(); // Rust 正常回了，只是不是字符串：算“没有”
  });

  it('读出错时镜像不动：没读到过的仍是 undefined，读到过的保持上一次的值（S2：分清“没读到”和“没登录”）', async () => {
    let fail = true;
    const s = desktopSessionStorage(async (cmd) => {
      if (cmd !== 'session_get') return null;
      if (fail) throw 'cred_error';
      return 'v1';
    });
    await s.preload([KEY]);
    expect(s.peek(KEY)).toBeUndefined();
    fail = false;
    expect(await s.getItem(KEY)).toBe('v1');
    fail = true;
    expect(await s.getItem(KEY)).toBeNull(); // 对 auth-js 照旧回 null
    expect(s.peek(KEY)).toBe('v1');
  });

  it('invoke 一直不返回：超时按失败处理，后面同一个键的操作不再卡住（S2）', async () => {
    let hang = true;
    const invoke: RawInvoke = async (cmd, args) => {
      if (hang) return new Promise(() => undefined);
      return cmd === 'session_get' ? 'v' : String(args?.key);
    };
    const s = desktopSessionStorage(invoke, KEYS, { timeoutMs: 20 });
    const g = s.getItem(KEY);
    const w = s.setItem(KEY, 'x');
    await expect(g).resolves.toBeNull();
    await expect(w).rejects.toThrow('session_timeout');
    expect(s.peek(KEY)).toBeUndefined();
    hang = false;
    await expect(s.getItem(KEY)).resolves.toBe('v');
  });

  it('preload 忽略名单外的键', async () => {
    const f = fakeSessionInvoke();
    const s = desktopSessionStorage(f.invoke);
    await s.preload([KEY, 'sb-other-auth-token']);
    expect(s.preloaded).toEqual([KEY]);
    expect(f.calls).toEqual([`session_get ${KEY}`]);
  });

  it('peek：没读过是 undefined；preload、读、写、删以后同步拿到最近的值', async () => {
    const f = fakeSessionInvoke();
    f.store.set(KEY, 'v1');
    const s = desktopSessionStorage(f.invoke);
    expect(s.peek(KEY)).toBeUndefined();
    await s.preload([KEY, `${KEY}-user`]);
    expect(s.peek(KEY)).toBe('v1');
    expect(s.peek(`${KEY}-user`)).toBeNull();
    expect(s.preloaded).toEqual([KEY, `${KEY}-user`]);
    await s.setItem(KEY, 'v2');
    expect(s.peek(KEY)).toBe('v2');
    await s.removeItem(KEY);
    expect(s.peek(KEY)).toBeNull();
  });

  it('同一个键按调用顺序排队：先发的慢读不会把后写的值盖回旧值', async () => {
    const store = new Map([[KEY, 'old']]);
    let releaseGet!: () => void;
    const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (cmd === 'session_get') {
        const v = store.get(KEY) ?? null;
        await new Promise<void>((r) => (releaseGet = r));
        return v;
      }
      store.set(KEY, String(args?.value));
      return null;
    };
    const s = desktopSessionStorage(invoke);
    const g = s.getItem(KEY);
    const w = s.setItem(KEY, 'new');
    await flush();
    releaseGet();
    expect(await g).toBe('old');
    await w;
    expect(s.peek(KEY)).toBe('new');
    expect(store.get(KEY)).toBe('new');
  });

  it('前一个操作失败不卡住后面的', async () => {
    let n = 0;
    const s = desktopSessionStorage(async (cmd) => {
      n++;
      if (cmd === 'session_set' && n === 1) throw 'boom';
      return null;
    });
    await expect(s.setItem(KEY, 'x')).rejects.toBe('boom');
    await expect(s.setItem(KEY, 'y')).resolves.toBeUndefined();
    expect(s.peek(KEY)).toBe('y');
  });

  it('不在 Tauri 里 createDesktopSessionStorage 返回 undefined（网页版照旧用 authStorage）', () => {
    expect(createDesktopSessionStorage()).toBeUndefined();
  });
});

/** 假的 __TAURI_INTERNALS__ 事件部分：emit(event) 调已订阅的回调 */
function fakeEvents() {
  const cbs = new Map<number, (ev: { payload: unknown }) => void>();
  const listening = new Map<number, string>();
  let next = 1;
  const t: TauriInternalsEvents = {
    transformCallback: (cb) => {
      const id = next++;
      cbs.set(id, cb);
      return id;
    },
    invoke: async (cmd, args) => {
      if (cmd === 'plugin:event|listen') {
        const id = next++;
        listening.set(id, `${String(args?.event)}#${String(args?.handler)}`);
        return id;
      }
      if (cmd === 'plugin:event|unlisten') {
        listening.delete(Number(args?.eventId));
        return null;
      }
      throw new Error(cmd);
    },
  };
  const emit = (event: string, payload: unknown = null) => {
    for (const v of listening.values()) {
      const [e, h] = v.split('#');
      if (e === event) cbs.get(Number(h))?.({ payload });
    }
  };
  return { t, emit, listening };
}

describe('N1：auth:done 以后 main 重新读会话', () => {
  it('收到 auth:done：先把 preload 过的键重读进镜像，再调回调；取消订阅后不再收', async () => {
    const f = fakeSessionInvoke();
    const s = desktopSessionStorage(f.invoke);
    await s.preload([KEY]);
    expect(s.peek(KEY)).toBeNull();
    const ev = fakeEvents();
    const seen: (string | null | undefined)[] = [];
    const off = await onAuthDone(s, () => {
      seen.push(s.peek(KEY));
    }, ev.t);
    f.store.set(KEY, '{"user":{"id":"u"}}'); // 登录小窗口经 session_set 写进凭据管理器
    ev.emit('auth:done');
    await flush();
    await flush();
    expect(seen).toEqual(['{"user":{"id":"u"}}']);
    off();
    await flush();
    expect(ev.listening.size).toBe(0);
  });

  it('重读失败、回调抛错都不冒成未处理的拒绝', async () => {
    const s = desktopSessionStorage(async () => {
      throw 'down';
    });
    await s.preload([KEY]);
    const ev = fakeEvents();
    let called = 0;
    await onAuthDone(s, async () => {
      called++;
      throw new Error('cb');
    }, ev.t);
    ev.emit('auth:done');
    await flush();
    await flush();
    expect(called).toBe(1);
  });

  it('quick-add:submit 也走同一个订阅，只交出合法文字', async () => {
    const ev = fakeEvents();
    const got: string[] = [];
    await onQuickAddText((x) => got.push(x), ev.t);
    ev.emit('quick-add:submit', { text: '明天 10 点' });
    ev.emit('quick-add:submit', { text: 1 });
    expect(got).toEqual(['明天 10 点']);
  });
});
