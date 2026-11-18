// 进隐私记少等几次往返（11-19 负责人“隐私记每次进去的时候都很慢”“隐私记感觉没变快”）：
// • status 在途去重：入口行、隐私记页同时要状态只发一次（真机 preview.416 两条 status 并排在飞）
// • Face ID 挑战提前要（prepareFace）：点按钮时不再等 webauthn_options；只用一次、超过 FACE_OPT_MAX_AGE_MS 不用、提前要的失败了当场再要
// • 取图并发 IMG_SLOTS = 4
import { describe, expect, it } from 'vitest';
import { FACE_OPT_MAX_AGE_MS, IMG_SLOTS } from '../data/session.ts';
import { held, make, statusSet } from './session-fakes.ts';

const opts = { ok: true, challenge: 'Y2g', rp_id: 'lemo.test', timeout_ms: 120_000, user_id: 'dXNlcg', credential_ids: ['aWQ'] };
const count = (calls: { action: string }[], a: string) => calls.filter((c) => c.action === a).length;

describe('status 在途去重', () => {
  it('同时要两次只发一次，两边拿到同一个结果；回来以后再要会再发', async () => {
    const h = held<unknown>();
    const { s, calls } = make({ status: () => h.p });
    const a = s.refreshStatus();
    const b = s.refreshStatus();
    expect(count(calls, 'status')).toBe(1);
    h.release(statusSet);
    expect(await a).toEqual(await b);
    expect(s.get().phase).toBe('locked');
    await s.refreshStatus();
    expect(count(calls, 'status')).toBe(2);
  });

  it('预热（quiet）没查成：界面状态不动（还是 loading、没有 status），之后照常再查', async () => {
    let n = 0;
    const { s, calls } = make({ status: () => (++n === 1 ? { ok: false, code: 'offline' } : statusSet) });
    expect((await s.refreshStatus({ quiet: true })).ok).toBe(false);
    expect(s.get()).toMatchObject({ phase: 'loading', status: null, lastError: null });
    expect((await s.refreshStatus()).ok).toBe(true);
    expect(s.get().phase).toBe('locked');
    expect(count(calls, 'status')).toBe(2);
  });

  it('赶上在飞的预热、预热又没查成：当场再查一次；预热查成了就直接用', async () => {
    const h = held<unknown>();
    let n = 0;
    const { s, calls } = make({ status: () => (++n === 1 ? h.p : statusSet) });
    void s.refreshStatus({ quiet: true });
    const p = s.refreshStatus();
    h.release({ ok: false, code: 'try_later' });
    expect((await p).ok).toBe(true);
    expect(count(calls, 'status')).toBe(2);
    const m = make();
    void m.s.refreshStatus({ quiet: true });
    expect((await m.s.refreshStatus()).ok).toBe(true);
    expect(count(m.calls, 'status')).toBe(1);
  });
});

describe('Face ID 挑战提前要', () => {
  it('prepareFace 以后点 Face ID 不再发 webauthn_options；用过一次就清，下一次当场要', async () => {
    const { s, calls } = make({ webauthn_options: () => opts });
    s.prepareFace();
    s.prepareFace();   // 手里有不满 60 秒的，不再要
    expect(count(calls, 'webauthn_options')).toBe(1);
    const r = await s.webauthnOptions('unlock');
    expect(r.ok && r.value.challenge).toBe('Y2g');
    expect(count(calls, 'webauthn_options')).toBe(1);
    await s.webauthnOptions('unlock');
    expect(count(calls, 'webauthn_options')).toBe(2);
  });

  it('要来超过 FACE_OPT_MAX_AGE_MS 的不用，当场再要', async () => {
    const { s, calls, clock } = make({ webauthn_options: () => opts });
    s.prepareFace();
    clock.ms += FACE_OPT_MAX_AGE_MS;
    await s.webauthnOptions('unlock');
    expect(count(calls, 'webauthn_options')).toBe(2);
  });

  it('提前要的失败了（断网）：点的时候当场再要', async () => {
    let n = 0;
    const { s, calls } = make({ webauthn_options: () => (++n === 1 ? { ok: false, code: 'offline' } : opts) });
    s.prepareFace();
    const r = await s.webauthnOptions('unlock');
    expect(r.ok).toBe(true);
    expect(count(calls, 'webauthn_options')).toBe(2);
  });

  it('还在飞时就点：等这一次，不另发', async () => {
    const h = held<unknown>();
    const { s, calls } = make({ webauthn_options: () => h.p });
    s.prepareFace();
    const p = s.webauthnOptions('unlock');
    h.release(opts);
    expect((await p).ok).toBe(true);
    expect(count(calls, 'webauthn_options')).toBe(1);
  });

  it('绑定（register）不用提前要的解锁挑战', async () => {
    const { s, calls } = make({ webauthn_options: () => opts });
    s.prepareFace();
    await s.webauthnOptions('register');
    expect(calls.filter((c) => c.action === 'webauthn_options').map((c) => (c.req as { purpose: string }).purpose)).toEqual(['unlock', 'register']);
  });
});

describe('取图并发', () => {
  it('IMG_SLOTS 是 4', () => {
    expect(IMG_SLOTS).toBe(4);
  });
});
