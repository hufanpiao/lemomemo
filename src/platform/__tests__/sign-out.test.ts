// 退出这台设备（架构 4.1、0.38 第 35～37 条；接手清单 K-signout-merge）：登录页和设置页共用的一份
// 删库、清理顺序、各步上限、①④ 总超时、晚到只挂在 signOut 上（原在 auth/__tests__/local-exit.test.ts、settings 的 local.test.ts、settings-api.test.ts）
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as session from '../session.ts';
import { defaultExitSteps, deleteLocalDb, signOutThisDevice, withTimeout, wipeThisDevice, type ExitSteps } from '../sign-out.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 假 IDBFactory：deleteDatabase 按 how 触发 success、error、只 blocked 不完成、或直接抛错 */
function fakeFactory(how: 'success' | 'error' | 'blocked' | 'throw') {
  const names: string[] = [];
  const factory = {
    deleteDatabase(name: string) {
      names.push(name);
      if (how === 'throw') throw new Error('SecurityError');
      const req: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {};
      setTimeout(() => {
        if (how === 'success') req.onsuccess?.();
        else if (how === 'error') req.onerror?.();
        else req.onblocked?.();
      }, 0);
      return req;
    },
  } as unknown as IDBFactory;
  return { factory, names };
}

/** 记下各步先后的假清理；wipe 不传就是登录页（按库名删库） */
function steps(log: string[], over: Partial<ExitSteps> = {}): ExitSteps & { [K in 'deleteDb' | 'clearCacheStorage' | 'clearLocalSession']: ReturnType<typeof vi.fn> } {
  return {
    deleteDb: vi.fn(async () => void log.push('deleteDb')),
    clearCacheStorage: vi.fn(async () => void log.push('caches')),
    clearLocalSession: vi.fn(() => void log.push('session')),
    ...over,
  } as never;
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const hang = <T>() => new Promise<T>(() => undefined);

describe('withTimeout', () => {
  it('按时回来用原值；超时用 fallback，之后才回来时调一次 onLate；抛错用 fallback', async () => {
    vi.useFakeTimers();
    expect(await withTimeout(async () => 1, 100, () => 0)).toBe(1);
    let release!: (v: number) => void;
    const onLate = vi.fn();
    const p = withTimeout(() => new Promise<number>((r) => (release = r)), 100, () => 0, onLate);
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toBe(0);
    expect(onLate).not.toHaveBeenCalled();
    release(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(await withTimeout(() => Promise.reject(new Error('x')), 100, () => -1)).toBe(-1);
  });
});

describe('deleteLocalDb', () => {
  it('成功、出错、抛错、没有 IndexedDB 各回各的结果，删的是 planner-v4', async () => {
    const ok = fakeFactory('success');
    expect(await deleteLocalDb(ok.factory)).toBe('deleted');
    expect(ok.names).toEqual(['planner-v4']);
    expect(await deleteLocalDb(fakeFactory('error').factory)).toBe('error');
    expect(await deleteLocalDb(fakeFactory('throw').factory)).toBe('error');
    expect(await deleteLocalDb(undefined)).toBe('unavailable');
  });

  it('别的标签页没关库（blocked）：最多等 waitMs，就按 blocked 往下走', async () => {
    vi.useFakeTimers();
    const p = deleteLocalDb(fakeFactory('blocked').factory, 'planner-v4', 3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toBe('blocked');
  });
});

describe('wipeThisDevice（清本机库和 Cache Storage）', () => {
  it('登录页（不传 wipe）：按库名删库，再清 Cache Storage', async () => {
    const log: string[] = [];
    await wipeThisDevice(steps(log));
    expect(log).toEqual(['deleteDb', 'caches']);
  });

  it('主 App：wipe 清掉了就不再删库；wipe 说库不能用、出错都改按库名删库；某一步失败不挡后面', async () => {
    const log: string[] = [];
    await wipeThisDevice(steps(log, { wipe: async () => (log.push('wipe'), true) }));
    expect(log).toEqual(['wipe', 'caches']);
    log.length = 0;
    await wipeThisDevice(steps(log, { wipe: async () => (log.push('wipe'), false) }));
    expect(log).toEqual(['wipe', 'deleteDb', 'caches']);
    log.length = 0;
    const s = steps(log, {
      wipe: async () => {
        throw new Error('closed');
      },
    });
    s.deleteDb.mockRejectedValueOnce(new Error('SecurityError'));
    await wipeThisDevice(s);
    expect(s.deleteDb).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['caches']);
  });

  it('清库卡住（别的标签页挡着）、清缓存卡住：各自到上限就往下走，不会一直等', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    let done = false;
    void wipeThisDevice(steps(log, { wipe: () => hang<boolean>(), clearCacheStorage: () => hang<void>() }), 3000, 2000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(log).toEqual(['deleteDb']);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).toBe(true);
  });

  it('默认几步：删本机会话用 session.ts 的 clearLocalSession，清缓存用 session.ts 的 clearCacheStorage（保留 workbox-precache）', () => {
    const spy = vi.spyOn(session, 'clearLocalSession').mockImplementation(() => undefined);
    defaultExitSteps.clearLocalSession();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(defaultExitSteps.clearCacheStorage).toBe(session.clearCacheStorage);
    expect(defaultExitSteps.wipe).toBeUndefined();
  });
});

describe('signOutThisDevice（①删行 ②清库 ③清缓存 ④signOut）', () => {
  it('顺序：删本会话那一行 → 清库 → 清缓存 → signOut；成功时不用兜底删会话', async () => {
    const log: string[] = [];
    const r = await signOutThisDevice({
      server: { deleteOwnDevice: async () => void log.push('row'), signOut: async () => (log.push('signout'), { serverDone: true }) },
      steps: steps(log),
      readUserId: () => 'u1',
    });
    expect(r).toEqual({ serverDone: true });
    expect(log).toEqual(['row', 'deleteDb', 'caches', 'signout', 'deleteDb']);
  });

  it('服务器没退成：最后兜底删本机会话', async () => {
    const log: string[] = [];
    const r = await signOutThisDevice({ server: { signOut: async () => (log.push('signout'), { serverDone: false }) }, steps: steps(log), readUserId: () => 'u1' });
    expect(r).toEqual({ serverDone: false });
    expect(log).toEqual(['deleteDb', 'caches', 'signout', 'session', 'deleteDb']);
  });

  it('signOut 抛异常：按没退成处理', async () => {
    const log: string[] = [];
    const r = await signOutThisDevice({
      server: {
        signOut: () => {
          throw new Error('boom');
        },
      },
      steps: steps(log),
      readUserId: () => 'u1',
    });
    expect(r).toEqual({ serverDone: false });
    expect(log).toEqual(['deleteDb', 'caches', 'session', 'deleteDb']);
  });

  it('signOut 永远不返回：到总超时照样清空、删会话；之后才回来、本机会话还是退出前的 user_id 就再删一次，别的账号不动', async () => {
    for (const [after, clears] of [
      ['u1', 2],
      ['u2', 1],
      [null, 1],
    ] as const) {
      vi.useFakeTimers();
      const log: string[] = [];
      const late = deferred<{ serverDone: boolean }>();
      let current: string | null = 'u1';
      const s = steps(log);
      const p = signOutThisDevice({ server: { signOut: () => late.promise }, steps: s, readUserId: () => current, timeoutMs: 8000 });
      await vi.advanceTimersByTimeAsync(7999);
      expect(log).toEqual(['deleteDb', 'caches']);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual({ serverDone: false });
      expect(log).toEqual(['deleteDb', 'caches', 'session', 'deleteDb']);
      current = after;
      late.resolve({ serverDone: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(s.clearLocalSession).toHaveBeenCalledTimes(clears);
      vi.useRealTimers();
    }
  });

  it('删行一直不返回：最多等总超时的一半；删行晚到不删会话（晚到处理只挂在 signOut 上）', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const row = deferred();
    const s = steps(log);
    const p = signOutThisDevice({
      server: { deleteOwnDevice: () => row.promise, signOut: async () => (log.push('signout'), { serverDone: true }) },
      steps: s,
      readUserId: () => 'u1',
      timeoutMs: 8000,
    });
    await vi.advanceTimersByTimeAsync(3999);
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ serverDone: true });
    expect(log).toEqual(['deleteDb', 'caches', 'signout', 'deleteDb']);
    row.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.clearLocalSession).not.toHaveBeenCalled();
  });

  it('删行用掉的时间从 signOut 的等待里扣：两步合计不超过总超时', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const p = signOutThisDevice({
      server: {
        deleteOwnDevice: () => new Promise<void>((r) => setTimeout(r, 3000)),
        signOut: () => hang<{ serverDone: boolean }>(),
      },
      steps: steps(log),
      readUserId: () => 'u1',
      timeoutMs: 8000,
    });
    await vi.advanceTimersByTimeAsync(7999);
    expect(log).toEqual(['deleteDb', 'caches']);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ serverDone: false });
  });

  it('清库那几秒会话还在、别的标签页借旧会话重建了库：会话删掉以后再删一次，退出结束时库不存在（复审 M2）', async () => {
    const dbs = new Set(['planner-v4']);
    const seq: string[] = [];
    const factory = {
      deleteDatabase(name: string) {
        seq.push('delete');
        dbs.delete(name);
        const req: { onsuccess?: () => void } = {};
        setTimeout(() => req.onsuccess?.(), 0);
        return req;
      },
    } as unknown as IDBFactory;
    const r = await signOutThisDevice({
      server: {
        signOut: async () => {
          // 别的主 App 标签页收到 versionchange 后 reload，用还在的旧会话重建了库
          dbs.add('planner-v4');
          seq.push('rebuilt');
          return { serverDone: false };
        },
      },
      steps: { deleteDb: () => deleteLocalDb(factory), clearCacheStorage: async () => undefined, clearLocalSession: () => void seq.push('session') },
      readUserId: () => 'u1',
    });
    expect(r).toEqual({ serverDone: false });
    expect(seq).toEqual(['delete', 'rebuilt', 'session', 'delete']);
    expect(dbs.has('planner-v4')).toBe(false);
  });

  it('按库名删库 blocked、出错、抛错：signOut 照样调；没退成时兜底删会话；最后那次删库出错也不影响结果', async () => {
    vi.useFakeTimers();
    for (const how of ['blocked', 'error', 'throw'] as const) {
      const log: string[] = [];
      const signOut = vi.fn(async () => (log.push('signout'), { serverDone: false }));
      const s = steps(log, {
        deleteDb: vi.fn(async () => {
          log.push(`deleteDb:${how}`);
          if (how === 'throw') throw new Error('SecurityError');
          return deleteLocalDb(fakeFactory(how).factory, 'planner-v4', 3000);
        }),
      });
      const p = signOutThisDevice({ server: { signOut }, steps: s, readUserId: () => 'u1' });
      await vi.advanceTimersByTimeAsync(7000);
      expect(await p).toEqual({ serverDone: false });
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(log).toEqual([`deleteDb:${how}`, 'caches', 'signout', 'session', `deleteDb:${how}`]);
    }
  });
});

describe('signOutThisDevice 先打“自己退出”的标记（K6-signedout）', () => {
  it('在删行、清库、signOut 之前打，只打一次（删行时刷新令牌失败引起的 SIGNED_OUT 也不按被移除处理）；默认用 markSelfSignOut', async () => {
    const log: string[] = [];
    await signOutThisDevice({
      server: { deleteOwnDevice: async () => void log.push('row'), signOut: async () => (log.push('signout'), { serverDone: true }) },
      steps: steps(log),
      readUserId: () => 'u1',
      markSelf: () => void log.push('mark'),
    });
    expect(log).toEqual(['mark', 'row', 'deleteDb', 'caches', 'signout', 'deleteDb']);
    // 默认用 session.ts 的 markSelfSignOut
    const spy = vi.spyOn(session, 'markSelfSignOut');
    await signOutThisDevice({ server: { signOut: async () => ({ serverDone: true }) }, steps: steps([]), readUserId: () => 'u1' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('signOutThisDevice 清日志上传队列（架构 0.38 第 68 条）', () => {
  afterEach(() => localStorage.clear());

  it('清本机那一步之后、signOut 之前清掉这个账号的 lemo.logq.<user_id>；别的账号、install_id 不动', async () => {
    localStorage.setItem('lemo.logq.u1', '{"items":[],"dropped":0}');
    localStorage.setItem('lemo.logq.u2', 'x');
    localStorage.setItem('lemo.install_id', 'i');
    const log: string[] = [];
    let atSignOut: string | null = 'unset';
    const r = await signOutThisDevice({
      server: { signOut: async () => ((atSignOut = localStorage.getItem('lemo.logq.u1')), log.push('signout'), { serverDone: true }) },
      steps: steps(log),
      readUserId: () => 'u1',
    });
    expect(r).toEqual({ serverDone: true });
    expect(atSignOut).toBeNull();
    expect(localStorage.getItem('lemo.logq.u2')).toBe('x');
    expect(localStorage.getItem('lemo.install_id')).toBe('i');
  });

  it('读不到是谁：清全部 lemo.logq.*', async () => {
    localStorage.setItem('lemo.logq.u1', 'a');
    localStorage.setItem('lemo.logq.u2', 'b');
    localStorage.setItem('pv-locale', 'ko');
    await signOutThisDevice({ server: { signOut: async () => ({ serverDone: true }) }, steps: steps([]), readUserId: () => null });
    expect(localStorage.getItem('lemo.logq.u1')).toBeNull();
    expect(localStorage.getItem('lemo.logq.u2')).toBeNull();
    expect(localStorage.getItem('pv-locale')).toBe('ko');
  });
});
