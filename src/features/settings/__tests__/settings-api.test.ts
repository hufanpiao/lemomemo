// 设置页接口：调的是哪个 RPC / 哪个 auth 方法、错误怎么归类（0.38 第 7 条：session_revoked、unauthorized、401 一律当没登录）
// 退出本机、被移除后清会话：signOut local 不是 ok（断网、getSession 出错、拿不到客户端）一律兜底删本机会话
// 读列表、移除、退出其他设备、改语言各有超时（K9 第二轮 N2），超时按 offline
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../platform/supabase/client.ts';
import { createSettingsApi, mapSettingsError, type SettingsApi } from '../data/settings-api.ts';

afterEach(() => {
  vi.useRealTimers();
});

function token(payload: object): string {
  return `h.${btoa(JSON.stringify(payload)).replace(/=+$/, '')}.s`;
}

interface FakeOpts {
  getSessionThrows?: boolean;
  signOutThrows?: boolean;
  session?: { user: { id: string }; access_token: string } | null;
  devices?: { data: unknown; error: unknown };
  mySessions?: { data: unknown; error: unknown };
  removeDevice?: { data: unknown; error: unknown };
  profileUpdate?: { data: unknown; error: unknown };
  signOut?: { error: unknown };
  updateUser?: { error: unknown };
}

function fakeDb(o: FakeOpts = {}) {
  const calls: unknown[][] = [];
  const session = o.session === undefined ? { user: { id: 'u1' }, access_token: token({ session_id: 's-me' }) } : o.session;
  const db = {
    auth: {
      getSession: vi.fn(async () => {
        if (o.getSessionThrows) throw new Error('getSession broke');
        return { data: { session }, error: null };
      }),
      signOut: vi.fn(async (opts: unknown) => {
        calls.push(['signOut', opts]);
        if (o.signOutThrows) throw new TypeError('Failed to fetch');
        return o.signOut ?? { error: null };
      }),
      updateUser: vi.fn(async (attrs: unknown) => {
        calls.push(['updateUser', attrs]);
        return o.updateUser ?? { error: null };
      }),
    },
    rpc: vi.fn(async (fn: string, args?: unknown) => {
      calls.push(['rpc', fn, args]);
      if (fn === 'my_sessions') return o.mySessions ?? { data: [{ orphan_count: 1, orphan_last_at: '2026-10-28T00:00:00Z', signed_out_device_ids: ['d2'] }], error: null };
      return o.removeDevice ?? { data: null, error: null };
    }),
    from: vi.fn((table: string) => ({
      select: (cols: string) => ({
        is: async (col: string, v: null) => {
          calls.push(['select', table, cols, col, v]);
          return o.devices ?? { data: [{ id: 'd1', platform: 'ios', label: 'A 的 iPhone', session_id: 's-me' }, { bad: true }], error: null };
        },
      }),
      delete: () => ({
        eq: async (col: string, v: string) => {
          calls.push(['delete', table, col, v]);
          return { data: null, error: null };
        },
      }),
      update: (val: unknown) => ({
        eq: async (col: string, v: string) => {
          calls.push(['update', table, val, col, v]);
          return o.profileUpdate ?? { data: null, error: null };
        },
      }),
    })),
  };
  const clear = vi.fn();
  return { db, calls, clear, api: createSettingsApi(async () => db as unknown as Db, clear) };
}

describe('mapSettingsError', () => {
  it('session_revoked（PostgREST 400 的 message）、unauthorized、401、刷新令牌失效、没有会话 → revoked', () => {
    expect(mapSettingsError({ code: 'P0001', message: 'session_revoked' })).toBe('revoked');
    expect(mapSettingsError({ message: 'unauthorized', status: 401 })).toBe('revoked');
    expect(mapSettingsError({ status: 401 })).toBe('revoked');
    expect(mapSettingsError({ name: 'AuthApiError', code: 'session_not_found', status: 403 })).toBe('revoked');
    expect(mapSettingsError({ name: 'AuthApiError', code: 'refresh_token_not_found', status: 400 })).toBe('revoked');
  });

  it('本机没有会话（AuthSessionMissingError）→ signed_out，不说“被移除”', () => {
    expect(mapSettingsError({ name: 'AuthSessionMissingError' })).toBe('signed_out');
  });

  it('account_disabled（注销冷静期、管理员停用）单独一类', () => {
    expect(mapSettingsError({ code: 'P0001', message: 'account_disabled' })).toBe('account_disabled');
  });

  it('try_later 只是稍后再试，不当被移除（0.29 续第 119 条②）', () => {
    expect(mapSettingsError({ message: 'try_later', status: 503 })).toBe('try_later');
    expect(mapSettingsError({ status: 503 })).toBe('try_later');
  });

  it('is_current_device、device_not_found、断网、其他', () => {
    expect(mapSettingsError({ code: 'P0001', message: 'is_current_device' })).toBe('is_current_device');
    expect(mapSettingsError({ code: 'P0001', message: 'device_not_found' })).toBe('device_not_found');
    expect(mapSettingsError({ message: 'TypeError: Failed to fetch', code: '' })).toBe('offline');
    expect(mapSettingsError({ name: 'AuthRetryableFetchError', status: 0 })).toBe('offline');
    expect(mapSettingsError(new TypeError('Failed to fetch'))).toBe('offline');
    expect(mapSettingsError(new TypeError('Load failed'))).toBe('offline');
    // 别的 TypeError 是代码出错，不当断网
    expect(mapSettingsError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe('unknown');
    expect(mapSettingsError({ code: '42501', message: 'permission denied' })).toBe('unknown');
    expect(mapSettingsError('x')).toBe('unknown');
    expect(mapSettingsError(new Error('supabase_env_missing'))).toBe('unknown');
  });
});

describe('createSettingsApi', () => {
  it('loadDevices：读 devices（含 created_at、session_id）和 my_sessions()，带回当前会话 id；格式不对的行丢掉', async () => {
    const { api, calls } = fakeDb();
    const r = await api.loadDevices();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.session).toBe('s-me');
    expect(r.value.rows).toHaveLength(1);
    expect(r.value.rows[0]).toMatchObject({ id: 'd1', label: 'A 的 iPhone', created_at: null });
    expect(r.value.sessions).toEqual([{ orphan_count: 1, orphan_last_at: '2026-10-28T00:00:00Z', signed_out_device_ids: ['d2'] }]);
    expect(calls).toContainEqual(['select', 'devices', 'id,label,platform,last_seen_at,created_at,session_id', 'deleted_at', null]);
    expect(calls).toContainEqual(['rpc', 'my_sessions', undefined]);
  });

  it('本机没有会话 → signed_out（别的标签页退出了），不发请求', async () => {
    const { api, calls } = fakeDb({ session: null });
    expect(await api.loadDevices()).toEqual({ ok: false, error: 'signed_out', sid: null });
    expect(calls).toEqual([]);
  });

  it('my_sessions 读不出来不挡设备列表；但回 session_revoked 照样当被移除', async () => {
    const a = fakeDb({ mySessions: { data: null, error: { message: 'boom' } } });
    const r = await a.api.loadDevices();
    expect(r.ok && r.value.sessions).toBeNull();
    const b = fakeDb({ mySessions: { data: null, error: { code: 'P0001', message: 'session_revoked' } } });
    expect(await b.api.loadDevices()).toEqual({ ok: false, error: 'revoked', sid: 's-me' });
  });

  it('removeDevice 调 rpc remove_device(p_device_id)，错误按码归类', async () => {
    const { api, calls } = fakeDb();
    expect(await api.removeDevice('d9')).toEqual({ ok: true, value: undefined });
    expect(calls).toContainEqual(['rpc', 'remove_device', { p_device_id: 'd9' }]);
    const b = fakeDb({ removeDevice: { data: null, error: { code: 'P0001', message: 'is_current_device' } } });
    expect(await b.api.removeDevice('d1')).toEqual({ ok: false, error: 'is_current_device' });
  });

  it('signOutOthers 走 auth.signOut({scope: "others"})（免查名单，不另写函数）', async () => {
    const { api, calls } = fakeDb();
    await api.signOutOthers();
    expect(calls).toEqual([['signOut', { scope: 'others' }]]);
  });

  it('deleteOwnDevice 删本机那一行；没有本机 id 时什么也不做', async () => {
    const { api, calls } = fakeDb();
    await api.deleteOwnDevice('d1');
    await api.deleteOwnDevice(null);
    expect(calls).toEqual([['delete', 'devices', 'id', 'd1']]);
  });

  it('dropLocalSession 成功：只 signOut local，不删设备行、不用兜底', async () => {
    const { api, calls, clear } = fakeDb();
    expect(await api.dropLocalSession('s-me')).toEqual({ serverDone: true });
    expect(calls).toEqual([['signOut', { scope: 'local' }]]);
    expect(clear).not.toHaveBeenCalled();
  });

  it('dropLocalSession 不先查 getSession：getSession 出错时照样退出', async () => {
    const { api, calls } = fakeDb({ getSessionThrows: true });
    expect(await api.dropLocalSession('s-me')).toEqual({ serverDone: true });
    expect(calls).toEqual([['signOut', { scope: 'local' }]]);
  });

  it('断网（signOut 回错误或直接抛）：兜底删本机会话，serverDone = false', async () => {
    const a = fakeDb({ signOut: { error: { name: 'AuthRetryableFetchError', status: 0 } } });
    expect(await a.api.dropLocalSession('s-me')).toEqual({ serverDone: false });
    expect(a.clear).toHaveBeenCalledTimes(1);
    const b = fakeDb({ signOutThrows: true });
    expect(await b.api.dropLocalSession('s-me')).toEqual({ serverDone: false });
    expect(b.clear).toHaveBeenCalledTimes(1);
  });

  it('dropLocalSession(sid)：兜底删会话时把 sid 原样转给 clearLocalSessionIf（只删那一个，K6-sugg3 ①；参数必填，K6-sugg4 ②）', async () => {
    const a = fakeDb({ signOutThrows: true });
    await a.api.dropLocalSession('s-me');
    expect(a.clear.mock.calls).toEqual([['s-me']]);
    const b = fakeDb({ signOutThrows: true });
    await b.api.dropLocalSession(null);
    expect(b.clear.mock.calls).toEqual([[null]]);
  });

  it('revoked 带回发请求时那个会话的 session_id（K6-sugg4 ①）：取 getSession 拿到的令牌，不是回包时本机的会话', async () => {
    const readSid = vi.fn((): string | null => 's-other');   // 回包时本机已是别的标签页写进来的会话
    const { db } = fakeDb({ removeDevice: { data: null, error: { code: 'P0001', message: 'session_revoked' } } });
    const api = createSettingsApi(async () => db as unknown as Db, vi.fn(), 8000, readSid);
    expect(await api.removeDevice('d9')).toEqual({ ok: false, error: 'revoked', sid: 's-me' });
    expect(await api.signOutOthers()).toEqual({ ok: true, value: undefined });
  });

  it('getSession 本身出错（刷新令牌被拒）：sid 取调 getSession 之前同步读的本机会话', async () => {
    const { db } = fakeDb();
    (db.auth.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { session: null }, error: { code: 'refresh_token_not_found', status: 400 } });
    const api = createSettingsApi(async () => db as unknown as Db, vi.fn(), 8000, () => 's-before');
    expect(await api.loadDevices()).toEqual({ ok: false, error: 'revoked', sid: 's-before' });
  });

  it('令牌已失效（服务器回 session_not_found）：兜底删本机会话，服务器那边本来就没了（serverDone = true）', async () => {
    const { api, clear } = fakeDb({ signOut: { error: { name: 'AuthApiError', code: 'session_not_found', status: 404 } } });
    expect(await api.dropLocalSession('s-me')).toEqual({ serverDone: true });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('拿不到客户端（getDb 抛错）：deleteOwnDevice 不报错，dropLocalSession 兜底删本机会话', async () => {
    const clear = vi.fn();
    const api = createSettingsApi(async () => {
      throw new Error('supabase_env_missing');
    }, clear);
    await expect(api.deleteOwnDevice('d1')).resolves.toBeUndefined();
    expect(await api.dropLocalSession('s-me')).toEqual({ serverDone: false });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('读列表、移除、退出其他设备、改语言卡住：到超时按 offline 返回，不清本机会话', async () => {
    vi.useFakeTimers();
    const clear = vi.fn();
    const api = createSettingsApi(() => new Promise<Db>(() => undefined), clear, 8000);
    const all = Promise.all([api.loadDevices(), api.removeDevice('d9'), api.signOutOthers(), api.saveLocale('ko-KR')]);
    await vi.advanceTimersByTimeAsync(8000);
    const off = { ok: false, error: 'offline' };
    expect(await all).toEqual([off, off, off, off]);
    expect(clear).not.toHaveBeenCalled();
  });

  it('dropLocalSession：只 signOut local，不删设备行', async () => {
    const { api, calls } = fakeDb();
    await api.dropLocalSession('s-me');
    expect(calls).toEqual([['signOut', { scope: 'local' }]]);
  });

  it('saveLocale 写 profiles.ui_locale 和 user_metadata.locale（2.4 第 4 条）', async () => {
    const { api, calls } = fakeDb();
    expect(await api.saveLocale('ko-KR')).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([
      ['update', 'profiles', { ui_locale: 'ko-KR' }, 'user_id', 'u1'],
      ['updateUser', { data: { locale: 'ko-KR' } }],
    ]);
    const b = fakeDb({ profileUpdate: { data: null, error: { message: 'unauthorized' } } });
    expect(await b.api.saveLocale('zh-CN')).toEqual({ ok: false, error: 'revoked', sid: 's-me' });
  });

  it('拿不到客户端（没配环境变量等）→ unknown，不当被移除', async () => {
    const api = createSettingsApi(async () => {
      throw new Error('supabase_env_missing');
    }, vi.fn());
    expect(await api.loadDevices()).toEqual({ ok: false, error: 'unknown' });
  });
});

// K6-sugg4 ②：不给 sid 的调用编不过（typecheck 检查；不执行）
function settingsApiShapes(api: SettingsApi): void {
  // @ts-expect-error 设置页 dropLocalSession 的 sid 必填
  void api.dropLocalSession();
  // @ts-expect-error 传 undefined 也不行
  void api.dropLocalSession(undefined);
}

it('K6-sugg4 ②：不给 session_id 的调用编不过（上面的 @ts-expect-error，由 typecheck 检查）', () => {
  expect(typeof settingsApiShapes).toBe('function');
});
