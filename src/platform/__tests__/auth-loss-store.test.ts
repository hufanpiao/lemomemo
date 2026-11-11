// R-382（架构 4.1a 第 2、3 点、第 6 点单测）：lemo.reauth 记号（auth-loss-store.ts）和 lemo.authloss 原因码、哈希（auth-loss-log.ts）的规则
import { afterEach, describe, expect, it } from 'vitest';
import * as reauthStore from '../auth-loss-store.ts';
import { FUTURE_SKEW_MS, REAUTH_KEY, REAUTH_TTL_MS, clearReauth, hasAuthLoss, readReauth, writeReauth } from '../auth-loss-store.ts';
import * as authLossLog from '../auth-loss-log.ts';
import { AUTH_CODE_RE as REFRESH_CODE_RE } from '../supabase/refresh-failure.ts';
import {
  AUTH_LOSS_KEY, AUTH_LOSS_MAX, authLossLogCode, clearAuthLoss, pairHash, pushAuthLoss, readAuthLoss, takeAuthLossFor, uidHash,
} from '../auth-loss-log.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const S = '00000000-0000-4000-8000-0000000000c1';
const I1 = '11111111-1111-4111-8111-111111111111';
const I2 = '22222222-2222-4222-8222-222222222222';
const NOW = 1_800_000_000_000;
/** node 算的：sha256("<S>:<A>") */
const PAIR = 'c4f676a46c3bcd5ff63e16d293e777f8081572771c8654de0b451740eec821f5';

afterEach(() => localStorage.clear());

/** 取第一条；没有就让用例失败（代替非空断言） */
function first<T>(list: readonly T[]): T {
  const v = list[0];
  if (v === undefined) throw new Error('列表是空的');
  return v;
}

// auth-loss-log.ts 为了不进首屏、不引首屏模块，几个常量各留了一份（见该文件开头）：两边必须同值
describe('首屏、懒加载两份常量一致', () => {
  it('键名、有效期、未来容差、原因码格式', () => {
    expect(authLossLog.AUTH_LOSS_KEY).toBe(reauthStore.AUTH_LOSS_KEY);
    expect(authLossLog.AUTH_LOSS_TTL_MS).toBe(reauthStore.REAUTH_TTL_MS);
    expect(authLossLog.AUTH_LOSS_SKEW_MS).toBe(reauthStore.FUTURE_SKEW_MS);
    expect(authLossLog.AUTH_CODE_RE.source).toBe(REFRESH_CODE_RE.source);
    expect(authLossLog.AUTH_CODE_RE.flags).toBe(REFRESH_CODE_RE.flags);
  });
  it('两个 clearAuthLoss 删的是同一个键', () => {
    localStorage.setItem(reauthStore.AUTH_LOSS_KEY, '[]');
    authLossLog.clearAuthLoss();
    expect(reauthStore.hasAuthLoss()).toBe(false);
    localStorage.setItem(reauthStore.AUTH_LOSS_KEY, '[]');
    reauthStore.clearAuthLoss();
    expect(localStorage.getItem(authLossLog.AUTH_LOSS_KEY)).toBeNull();
  });
});

describe('lemo.reauth', () => {
  it('写了读得回；30 天以内有效', () => {
    expect(writeReauth(A, S, NOW)).toBe(true);
    expect(readReauth(NOW)).toEqual({ v: 1, user_id: A, session_id: S, at: NOW });
    expect(readReauth(NOW + REAUTH_TTL_MS - 1)).not.toBeNull();
  });

  it('过了 30 天、时间晚于本机 1 天以上、认不出：都当没有', () => {
    writeReauth(A, S, NOW);
    expect(readReauth(NOW + REAUTH_TTL_MS)).toBeNull();
    writeReauth(A, S, NOW + FUTURE_SKEW_MS + 1);
    expect(readReauth(NOW)).toBeNull();
    writeReauth(A, S, NOW + FUTURE_SKEW_MS);
    expect(readReauth(NOW)).not.toBeNull();   // 正好 1 天还算
    for (const raw of [
      'x', '{}',
      JSON.stringify({ v: 2, user_id: A, session_id: S, at: NOW }),
      JSON.stringify({ v: 1, user_id: 'a-b', session_id: S, at: NOW }),
      JSON.stringify({ v: 1, user_id: A, session_id: 'tok', at: NOW }),
      JSON.stringify({ v: 1, user_id: A, session_id: S, at: 'now' }),
    ]) {
      localStorage.setItem(REAUTH_KEY, raw);
      expect(readReauth(NOW)).toBeNull();
    }
  });

  it('session_id 可以是 null；不是 uuid 的不写', () => {
    expect(writeReauth(A, null, NOW)).toBe(true);
    expect(readReauth(NOW)?.session_id).toBeNull();
    expect(writeReauth('not-uuid', S, NOW)).toBe(false);
    expect(writeReauth(A, 'not-uuid', NOW)).toBe(false);
  });

  it('存储不可用：写返回 false、读回 null、删返回 false', () => {
    const boom = (): never => {
      throw new Error('x');
    };
    const broken = { getItem: boom, setItem: boom, removeItem: boom } as unknown as Storage;
    expect(writeReauth(A, S, NOW, broken)).toBe(false);
    expect(readReauth(NOW, broken)).toBeNull();
    expect(clearReauth(broken)).toBe(false);
  });

  it('clearReauth 删掉记号', () => {
    writeReauth(A, S, NOW);
    expect(clearReauth()).toBe(true);
    expect(localStorage.getItem(REAUTH_KEY)).toBeNull();
  });
});

describe('pairHash / uidHash', () => {
  it('pairHash 钉固定样例：sha256("<sid>:<uid>") 小写十六进制（和迁移 private.session_pair_hash 同口径）', async () => {
    expect(await pairHash(S, A)).toBe(PAIR);
    expect(await pairHash(S.toUpperCase(), A.toUpperCase())).toBe(PAIR);
    expect(await pairHash('x', A)).toBeNull();
  });

  it('uidHash 加盐：两个 install_id 下不同，各 16 位', async () => {
    expect(await uidHash(A, I1)).toBe('b3226b6aca4f65ab');
    expect(await uidHash(A, I2)).toBe('c9991ecc1121ecf7');
    expect(await uidHash(A, null)).toBeNull();
  });
});

describe('lemo.authloss', () => {
  const base = { userId: A, path: 'sdk' as const, code: 'session_not_found', status: 403, fate: 'revoked' as const, app: '4.0.0', installId: I1 };

  it('只存 uid_h 等几个字段，不存明文 user_id', async () => {
    expect(await pushAuthLoss({ ...base, now: NOW })).toBe(true);
    expect(localStorage.getItem(AUTH_LOSS_KEY) ?? '').not.toContain(A);
    const list = readAuthLoss(NOW);
    expect(list).toEqual([{ uid_h: 'b3226b6aca4f65ab', path: 'sdk', code: 'session_not_found', status: 403, fate: 'revoked', at: NOW, app: '4.0.0' }]);
    expect(authLossLogCode(first(list))).toBe('sdk:session_not_found:403:revoked');
  });

  it('码不合白名单记 unparsable，没有码记 none；状态超范围记 0', async () => {
    await pushAuthLoss({ ...base, code: 'Bearer eyJ.abc', now: NOW });
    await pushAuthLoss({ ...base, code: null, status: 12345, now: NOW });
    expect(readAuthLoss(NOW).map((e) => [e.code, e.status])).toEqual([['unparsable', 403], ['none', 0]]);
  });

  it('最多 AUTH_LOSS_MAX 条，旧的挤掉', async () => {
    for (let i = 0; i < AUTH_LOSS_MAX + 2; i++) await pushAuthLoss({ ...base, now: NOW + i });
    const list = readAuthLoss(NOW + 10);
    expect(list).toHaveLength(AUTH_LOSS_MAX);
    expect(first(list).at).toBe(NOW + 2);
  });

  it('每条 30 天；时间在未来 1 天以上的丢掉', async () => {
    await pushAuthLoss({ ...base, now: NOW });
    expect(readAuthLoss(NOW + REAUTH_TTL_MS)).toEqual([]);
    localStorage.clear();
    await pushAuthLoss({ ...base, now: NOW + FUTURE_SKEW_MS + 1 });
    expect(readAuthLoss(NOW)).toEqual([]);
  });

  it('多出来的字段读出来不留', () => {
    localStorage.setItem(AUTH_LOSS_KEY, JSON.stringify([{ uid_h: 'b3226b6aca4f65ab', path: 'sdk', code: 'x', status: 0, fate: 'expired', at: NOW, app: '4', extra: 'e' }]));
    expect(Object.keys(first(readAuthLoss(NOW)))).not.toContain('extra');
  });

  it('takeAuthLossFor：按哈希只取本账号的，然后整个键删掉；换了 install_id 对不上就不取', async () => {
    await pushAuthLoss({ ...base, now: NOW });
    await pushAuthLoss({ ...base, userId: B, now: NOW });
    const mine = await takeAuthLossFor(A, I1, NOW);
    expect(mine).toHaveLength(1);
    expect(first(mine).uid_h).toBe('b3226b6aca4f65ab');
    expect(localStorage.getItem(AUTH_LOSS_KEY)).toBeNull();
    await pushAuthLoss({ ...base, now: NOW });
    expect(await takeAuthLossFor(A, I2, NOW)).toEqual([]);
  });

  it('clearAuthLoss 删掉整个键；hasAuthLoss 跟着变（main.tsx 据此决定要不要下载 auth-loss-log.ts）', async () => {
    expect(hasAuthLoss()).toBe(false);
    await pushAuthLoss({ ...base, now: NOW });
    expect(hasAuthLoss()).toBe(true);
    clearAuthLoss();
    expect(localStorage.getItem(AUTH_LOSS_KEY)).toBeNull();
    expect(hasAuthLoss()).toBe(false);
  });
});
