// invite 数据层（架构 5.6 发码、第 6 节 invite-admin）：发的请求体、响应按 zod 认、错误码归类、备注长度按码点、4 位一组、作废
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FnCall } from '../../../platform/fn-call.ts';

const calls: { fn: string; body: unknown; timeout: number }[] = [];
let reply: FnCall = { ok: true, status: 200, body: null };
vi.mock('../../../platform/fn-call.ts', () => ({
  defaultFnDeps: () => ({}),
  callFn: (fn: string, body: unknown, _s: AbortSignal, timeout: number) => {
    calls.push({ fn, body, timeout });
    return Promise.resolve(reply);
  },
}));
const api = await import('../data/invite-api.ts');

afterEach(() => {
  calls.length = 0;
});

const NEW = { code: 'K7Q2M9XD4TPA', expires_at: '2026-12-04T06:30:00.000Z' };
const ROW = { id: 'abcdef01', note: '3 号', max_uses: 1, used_count: 0, expires_at: '2026-12-04T06:30:00.123456+00:00' };

describe('create', () => {
  it('发 {action: create, note}：备注去首尾空白；空的、只有空白的不带 note；函数名 invite-admin、等 10 秒', async () => {
    reply = { ok: true, status: 200, body: NEW };
    await expect(api.createInvite('  3 号 ')).resolves.toEqual({ ok: true, value: NEW });
    await api.createInvite('   ');
    expect(calls).toEqual([
      { fn: 'invite-admin', body: { action: 'create', note: '3 号' }, timeout: 10_000 },
      { fn: 'invite-admin', body: { action: 'create' }, timeout: 10_000 },
    ]);
  });

  it('备注超过 40 个字（按码点：一个表情算一个字）当场回 note_too_long、不发；正好 40 个照发', async () => {
    reply = { ok: true, status: 200, body: NEW };
    await expect(api.createInvite('字'.repeat(41))).resolves.toEqual({ ok: false, err: 'note_too_long' });
    expect(calls).toHaveLength(0);
    expect(api.noteLength('😀'.repeat(40))).toBe(40);
    await expect(api.createInvite('😀'.repeat(40))).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it('认不出的回包（码不是 12 位大写字母数字、多了键、时刻认不出）当 bad_response', async () => {
    for (const body of [{ ...NEW, code: 'abc' }, { ...NEW, extra: 1 }, { ...NEW, expires_at: '明天' }, null]) {
      reply = { ok: true, status: 200, body };
      await expect(api.createInvite('')).resolves.toEqual({ ok: false, err: 'bad_response' });
    }
  });
});

describe('list', () => {
  it('发 {action: list}，回 invites 数组；Postgres 的“+00:00”、微秒时刻也认；note、次数、时刻可以是 null', async () => {
    const nulls = { id: '0123456789abcdef', note: null, max_uses: null, used_count: null, expires_at: null };
    reply = { ok: true, status: 200, body: { invites: [ROW, nulls] } };
    await expect(api.listInvites()).resolves.toEqual({ ok: true, value: [ROW, nulls] });
    expect(calls[0]).toMatchObject({ fn: 'invite-admin', body: { action: 'list' } });
  });

  it('回包里带了码（多了键）也不收：当 bad_response', async () => {
    reply = { ok: true, status: 200, body: { invites: [{ ...ROW, code_hash: 'x' }] } };
    await expect(api.listInvites()).resolves.toEqual({ ok: false, err: 'bad_response' });
  });

  it('id 只认 8 位或 16 位小写十六进制：没有、大写、完整哈希、别的长度一律 bad_response', async () => {
    const { id: _id, ...noId } = ROW;
    for (const row of [noId, { ...ROW, id: 'ABCDEF01' }, { ...ROW, id: 'a'.repeat(64) }, { ...ROW, id: 'abcdef0' }, { ...ROW, id: 1 }]) {
      reply = { ok: true, status: 200, body: { invites: [row] } };
      await expect(api.listInvites(), JSON.stringify(row)).resolves.toEqual({ ok: false, err: 'bad_response' });
    }
  });
});

describe('revoke', () => {
  it('发 {action: revoke, id}，回 {ok: true} 当成功；别的回包当 bad_response', async () => {
    reply = { ok: true, status: 200, body: { ok: true } };
    await expect(api.revokeInvite('abcdef01')).resolves.toEqual({ ok: true, value: true });
    expect(calls).toEqual([{ fn: 'invite-admin', body: { action: 'revoke', id: 'abcdef01' }, timeout: 10_000 }]);
    for (const body of [{ ok: false }, { ok: true, extra: 1 }, null]) {
      reply = { ok: true, status: 200, body };
      await expect(api.revokeInvite('abcdef01')).resolves.toEqual({ ok: false, err: 'bad_response' });
    }
  });

  it('404 not_found 原样给出去（已用掉、已过期、已作废）', async () => {
    reply = { ok: true, status: 404, body: { error: 'not_found' } };
    await expect(api.revokeInvite('abcdef01')).resolves.toEqual({ ok: false, err: 'not_found' });
  });
});

describe('错误归类', () => {
  it('invite-admin 的五个码和 bad_request 原样；401 / unauthorized / account_* 归 signed_out；别的归 failed；没登录、超时、断网', async () => {
    const cases: [FnCall, string][] = [
      [{ ok: true, status: 403, body: { error: 'not_admin' } }, 'not_admin'],
      [{ ok: true, status: 400, body: { error: 'note_too_long' } }, 'note_too_long'],
      [{ ok: true, status: 400, body: { error: 'bad_request' } }, 'bad_request'],
      [{ ok: true, status: 429, body: { error: 'rate_limited' } }, 'rate_limited'],
      [{ ok: true, status: 503, body: { error: 'try_later' } }, 'try_later'],
      [{ ok: true, status: 404, body: { error: 'not_found' } }, 'not_found'],
      [{ ok: true, status: 401, body: null }, 'signed_out'],
      [{ ok: true, status: 403, body: { error: 'session_revoked' } }, 'signed_out'],
      [{ ok: true, status: 426, body: { error: 'upgrade_required' } }, 'failed'],
      [{ ok: true, status: 500, body: { error: 'misconfigured' } }, 'failed'],
      [{ ok: false, code: 'no_session' }, 'signed_out'],
      [{ ok: false, code: 'timeout' }, 'timeout'],
      [{ ok: false, code: 'network' }, 'offline'],
    ];
    for (const [r, err] of cases) {
      reply = r;
      await expect(api.createInvite('')).resolves.toEqual({ ok: false, err });
    }
  });
});

describe('显示', () => {
  it('4 位一组、横线连（同线框 K7Q2-M9XD-4TPA）', () => {
    expect(api.groupInvite('K7Q2M9XD4TPA')).toBe('K7Q2-M9XD-4TPA');
  });

  it('用完了没有：used_count ≥ max_uses；读不出来的当没用', () => {
    expect(api.usedUp(ROW)).toBe(false);
    expect(api.usedUp({ ...ROW, used_count: 1 })).toBe(true);
    expect(api.usedUp({ ...ROW, used_count: null })).toBe(false);
  });

  it('能不能作废：还没用完的才能；用完了、次数读不出来的不能', () => {
    expect(api.revocable(ROW)).toBe(true);
    expect(api.revocable({ ...ROW, used_count: 1 })).toBe(false);
    expect(api.revocable({ ...ROW, used_count: null })).toBe(false);
    expect(api.revocable({ ...ROW, max_uses: null })).toBe(false);
  });
});
