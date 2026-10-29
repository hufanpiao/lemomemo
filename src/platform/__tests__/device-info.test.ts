// 设备行要用到的本机信息：install_id、devices.platform、跨标签页的锁（platform/device-info.ts），
// 以及令牌里的 session_id（platform/session.ts 的 sessionIdOfToken、readSessionId，K4 审查 6 合并成一份后放这里测）
import { afterEach, describe, expect, it } from 'vitest';
import { devicePlatform, INSTALL_ID_KEY, readInstallId, withLock } from '../device-info.ts';
import { readSessionId, sessionIdOfToken } from '../session.ts';
import type { LocksLike } from '../tab-leader.ts';

const SID = '11111111-1111-4111-8111-111111111111';
const URL_ = 'https://lemomemo.com/sb';

const b64url = (o: object): string => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload: object): string => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;

afterEach(() => {
  localStorage.clear();
});

describe('sessionIdOfToken / readSessionId', () => {
  it('只取 payload 里非空字符串的 session_id；坏令牌、没有、类型不对都为 null', () => {
    expect(sessionIdOfToken(jwt({ session_id: SID }))).toBe(SID);
    expect(sessionIdOfToken(jwt({ sub: 'x' }))).toBeNull();
    expect(sessionIdOfToken(jwt({ session_id: '' }))).toBeNull();
    expect(sessionIdOfToken(jwt({ session_id: 1 }))).toBeNull();
    expect(sessionIdOfToken('not-a-jwt')).toBeNull();
    expect(sessionIdOfToken('a.%%%.b')).toBeNull();
    expect(sessionIdOfToken(null)).toBeNull();
  });

  it('按 supabase-js 的会话键读 access_token；没登录、坏 JSON 为 null；读不出主机名时按格式找', () => {
    expect(readSessionId(localStorage, URL_)).toBeNull();
    localStorage.setItem('sb-lemomemo-auth-token', JSON.stringify({ access_token: jwt({ session_id: SID }), user: { id: 'x' } }));
    expect(readSessionId(localStorage, URL_)).toBe(SID);
    expect(readSessionId(localStorage, '')).toBe(SID);
    localStorage.setItem('sb-lemomemo-auth-token', 'not json');
    expect(readSessionId(localStorage, URL_)).toBeNull();
  });
});

describe('readInstallId（0.29 续第 109 条）', () => {
  it('第一次生成并存下，之后一直读同一个', () => {
    let n = 0;
    const gen = (): string => `33333333-3333-4333-8333-33333333333${++n}`;
    const a = readInstallId(localStorage, gen);
    expect(a).toBe('33333333-3333-4333-8333-333333333331');
    expect(localStorage.getItem(INSTALL_ID_KEY)).toBe(a);
    expect(readInstallId(localStorage, gen)).toBe(a);
    expect(n).toBe(1);
  });

  it('存的值格式不对：重新生成', () => {
    localStorage.setItem(INSTALL_ID_KEY, 'junk');
    expect(readInstallId(localStorage, () => '44444444-4444-4444-8444-444444444444')).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('localStorage 用不了（隐私模式抛错）：返回 null，不抛', () => {
    const bad = { getItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(readInstallId(bad)).toBeNull();
  });
});

describe('devicePlatform', () => {
  const nav = (ua: string, maxTouchPoints = 0) => ({ userAgent: ua, maxTouchPoints });
  it('iPhone、iPad（伪装成 Mac）记 ios；电脑、安卓记 web；Tauri 窗口记 tauri', () => {
    expect(devicePlatform(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), {})).toBe('ios');
    expect(devicePlatform(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), {})).toBe('ios');
    expect(devicePlatform(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), {})).toBe('web');
    expect(devicePlatform(nav('Mozilla/5.0 (Linux; Android 14)'), {})).toBe('web');
    expect(devicePlatform(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), { __TAURI_INTERNALS__: {} })).toBe('tauri');
  });
});

describe('withLock', () => {
  it('有 locks：拿到锁后跑、返回 fn 的结果，锁名照传；没有 locks：直接跑', async () => {
    const names: string[] = [];
    const locks: LocksLike = {
      request: async (name, _o, cb) => {
        names.push(name);
        await cb();
      },
    };
    expect(await withLock('lemo-device-reg:A', () => Promise.resolve(7), locks)).toBe(7);
    expect(names).toEqual(['lemo-device-reg:A']);
    expect(await withLock('x', () => Promise.resolve('ok'), null)).toBe('ok');
  });

  it('fn 抛错：照样抛出（锁随之释放）', async () => {
    const locks: LocksLike = { request: async (_n, _o, cb) => cb() };
    await expect(withLock('x', () => Promise.reject(new Error('boom')), locks)).rejects.toThrow('boom');
  });
});
