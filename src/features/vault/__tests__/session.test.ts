// 隐私记会话（data/session.ts）：TC-B5-10（59 秒 / 61 秒，注入时间）、TC-B5-11（上锁不留明文、blob 撤销）、
// TC-B5-47 ①②（vault_locked 等解锁后自动重试一次；vault_relock 丢令牌、记 relocked）、TC-B5-33（断网）、图片半路上锁丢掉结果、
// 锁着时“里面有 N 条”（R-436 丁批：同步还没拉回本机集合的也数上，原来写 0 条）
import { describe, expect, it, vi } from 'vitest';
import { VAULT_TOKEN_TTL_S } from '../../../../shared/schema/vault.ts';
import { setVaultToken, vaultToken } from '../../../core/vault-token.ts';
import { createVaultSession } from '../data/session.ts';
import type { VaultFail } from '../data/vault-api.ts';
import { countVault, noteRowOf } from '../data/vault-store.ts';
import { fakeApi, IMG, listOk, make, NID, note, queueDelete, statusSet, TOK, TOK2, tokenOk, unlocked } from './session-fakes.ts';

describe('解锁、上锁', () => {
  it('解锁后拉列表，明文只在内存；令牌抄给 core/vault-token', async () => {
    const { s, tokens } = await unlocked();
    expect(s.get().phase).toBe('unlocked');
    expect(s.get().listed).toBe(true);
    expect(s.store.get(NID)?.['body']).toBe('血压 120/80');
    expect(tokens.at(-1)).toBe(TOK);
    expect(s.hasToken()).toBe(true);
  });

  it('TC-B5-11：上锁清明文、清令牌、撤销全部 blob 地址；撤销后不再给旧地址', async () => {
    const { s, tokens, revoked } = await unlocked();
    const url = await s.image(IMG, 'thumb');
    expect(url).toBe('blob:x/1');
    expect(s.blobCount()).toBe(1);
    s.lock();
    expect(s.get()).toMatchObject({ phase: 'locked', listed: false });
    expect(s.store.getSnapshot()).toMatchObject({ notes: [], images: [] });
    expect(s.hasToken()).toBe(false);
    expect(tokens.at(-1)).toBeNull();
    expect(revoked).toEqual(['blob:x/1']);
    expect(s.blobCount()).toBe(0);
    expect(await s.image(IMG, 'thumb')).toBeNull();
  });

  it('取图半路上锁：结果丢掉，不造新地址', async () => {
    const { s, api } = await unlocked();
    let release!: () => void;
    vi.mocked(api.imageGet).mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ ok: true, value: new Blob(['y']) }))),
    );
    const p = s.image(IMG, 'full');
    s.lock();
    release();
    expect(await p).toBeNull();
    expect(s.blobCount()).toBe(0);
  });

  it('输错：记下还能试几次；锁定：记下到什么时候', async () => {
    const m = make({ unlock: () => ({ ok: false, code: 'pin_wrong', left: 3 }) });
    await m.s.refreshStatus();
    await m.s.unlock('0000');
    expect(m.s.get()).toMatchObject({ phase: 'locked', left: 3, lastError: 'pin_wrong' });
    const m2 = make({ unlock: () => ({ ok: false, code: 'pin_locked', retryAfterS: 30 }) });
    await m2.s.refreshStatus();
    await m2.s.unlock('0000');
    expect(m2.s.get()).toMatchObject({ lockedUntil: 1_000_000 + 30_000, left: 0, lastError: 'pin_locked' });
  });

  it('隐私记整块收拾 11-20 高 2：lastError 不跨动作留着——上锁、status 成功都清掉', async () => {
    const m = make({ unlock: () => ({ ok: false, code: 'pin_wrong', left: 3 }) });
    await m.s.refreshStatus();
    await m.s.unlock('0000');
    expect(m.s.get().lastError).toBe('pin_wrong');
    m.s.lock();
    expect(m.s.get().lastError).toBeNull();
    await m.s.unlock('0000');
    expect(m.s.get().lastError).toBe('pin_wrong');
    await m.s.refreshStatus();
    expect(m.s.get().lastError).toBeNull();
  });

  it('审查第 5 条：status 的锁定倒计时按服务器给的相对秒数算，不拿服务器绝对时刻比本机时钟（本机慢了一小时也对）', async () => {
    const m = make({ status: () => ({ ...statusSet, locked_until: 1_000_000 + 3_600_000 + 45_000, retry_after_s: 45 }) });
    await m.s.refreshStatus();
    expect(m.s.get().lockedUntil).toBe(1_000_000 + 45_000);
    const m2 = make({ status: () => ({ ...statusSet, locked_until: 500_000, retry_after_s: 45 }) });
    await m2.s.refreshStatus();
    expect(m2.s.get().lockedUntil).toBe(1_000_000 + 45_000);
    const m3 = make({ status: () => ({ ...statusSet, retry_after_s: null }) });
    await m3.s.refreshStatus();
    expect(m3.s.get().lockedUntil).toBeNull();
  });
});

describe('TC-B5-10：离开满时长才上锁（注入时间）', () => {
  it('1 分钟：59 秒回来仍解锁，61 秒回来已上锁', async () => {
    const { s } = await unlocked();
    s.hide(0);
    expect(s.show(59_000)).toBe(false);
    expect(s.get().phase).toBe('unlocked');
    s.hide(100_000);
    expect(s.show(161_000)).toBe(true);
    expect(s.get()).toMatchObject({ phase: 'locked', listed: false });
  });

  it('改时长生效：5 分钟时 4 分 59 秒不锁、5 分 1 秒锁', async () => {
    const { s } = await unlocked();
    s.hide(0);
    s.setAutolock(5);
    expect(s.show(299_000)).toBe(false);
    s.hide(0);
    expect(s.show(301_000)).toBe(true);
  });

  it('锁着时离开、回来什么也不动', async () => {
    const m = make();
    await m.s.refreshStatus();
    m.s.hide(0);
    expect(m.s.show(999_000)).toBe(false);
    expect(m.s.get().phase).toBe('locked');
  });
});

describe('TC-B5-47：错误码怎么落', () => {
  it('① vault_locked（后台队列发的）：上锁、弹解锁（waiting）、队列暂停不丢；解锁后队列重发一次，第二次带新令牌', async () => {
    let n = 0;
    const { s, calls } = await unlocked({
      delete: () => (++n === 1 ? { ok: false, code: 'vault_locked' } : { ok: true, vault_token: TOK2, expires_at: 9e12 }),
    });
    const row = s.store.get(NID);
    if (!row) throw new Error('no row');
    s.queue.deleted({ ...row, deleted_at: 5 }, true);
    await vi.waitFor(() => expect(s.get().waiting).toBe(true));
    expect(s.get()).toMatchObject({ phase: 'locked', listed: false });
    expect(s.queue.size()).toBe(1);
    await s.unlock('1234');
    await vi.waitFor(() => expect(s.queue.size()).toBe(0));
    const dels = calls.filter((c) => c.action === 'delete');
    expect(dels).toHaveLength(2);
    expect(dels[1]?.token).not.toBeNull();
    expect(s.get().waiting).toBe(false);
  });

  it('① 不进队列的写（永久删除）锁着：直接回 vault_locked、弹解锁卡；会话不排队等，解锁后不自己重发', async () => {
    const { s, calls } = await unlocked({ purge: () => ({ ok: false, code: 'vault_locked' }) });
    const r = await s.purge([NID]);
    expect(r).toMatchObject({ ok: false, code: 'vault_locked' });
    expect(s.get()).toMatchObject({ phase: 'locked', waiting: true });
    await s.unlock('1234');
    expect(calls.filter((c) => c.action === 'purge')).toHaveLength(1);
    expect(s.get().phase).toBe('unlocked');
  });

  it('① 取消解锁：等同主动上锁，队列整个丢掉（H2），不再发', async () => {
    const { s, calls } = await unlocked({ delete: () => ({ ok: false, code: 'vault_locked' }) });
    const row = s.store.get(NID);
    if (!row) throw new Error('no row');
    s.queue.deleted({ ...row, deleted_at: 5 }, true);
    await vi.waitFor(() => expect(s.get().waiting).toBe(true));
    s.cancelWait();
    expect(s.get()).toMatchObject({ phase: 'locked', waiting: false });
    expect(s.queue.size()).toBe(0);
    expect(s.store.getSnapshot().dropped).toBe(1);
    expect(calls.filter((c) => c.action === 'delete')).toHaveLength(1);
  });

  it('② vault_relock：丢令牌、清明文、relocked = true（不显示 Face ID）；用新密码解锁后 relocked 复位', async () => {
    const { s } = await unlocked({ save: () => ({ ok: false, code: 'vault_relock' }) });
    s.queue.wrote({ ...noteRowOf(note()), body: 'b' }, false);
    await vi.waitFor(() => expect(s.get()).toMatchObject({ phase: 'locked', listed: false, relocked: true }));
    expect(s.queue.size()).toBe(0);
    expect(s.hasToken()).toBe(false);
    await s.unlock('5678');
    expect(s.get().relocked).toBe(false);
  });

  it('session_revoked：上锁（退出交给同步引擎）', async () => {
    let n = 0;
    const { s } = await unlocked({ list: () => (++n === 1 ? listOk() : { ok: false, code: 'session_revoked' }) });
    await s.list();
    expect(s.get()).toMatchObject({ phase: 'locked', listed: false, lastError: 'session_revoked' });
  });

  it('⑥ try_later：只记码，不上锁', async () => {
    const { s } = await unlocked({ delete: () => ({ ok: false, code: 'try_later' }) });
    queueDelete(s);
    await vi.waitFor(() => expect(s.get().lastError).toBe('try_later'));
    expect(s.get().phase).toBe('unlocked');
  });
});

describe('TC-B5-33：断网', () => {
  it('锁着时断网：进不去（phase = offline），没有明文；联网后能正常解锁', async () => {
    let online = false;
    const m = make({ status: () => (online ? statusSet : { ok: false, code: 'offline' }) });
    await m.s.refreshStatus();
    expect(m.s.get()).toMatchObject({ phase: 'offline', listed: false });
    online = true;
    await m.s.refreshStatus();
    expect(m.s.get().phase).toBe('locked');
    expect((await m.s.unlock('1234')).ok).toBe(true);
    expect(m.s.get().phase).toBe('unlocked');
  });
});

describe('保存、移进隐私记（B5 隐私记重写：界面只写仓库，后台队列去发）', () => {
  const NEW = '33333333-3333-4333-8333-333333333333';
  const IMG_NEW = '44444444-4444-4444-8444-444444444444';
  const pic = { id: IMG_NEW, full: new Blob(['f']), thumb: new Blob(['t']), width: 10, height: 20 };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const newRow = () => ({ ...noteRowOf(note({ id: NEW, title: 't', body: 'b' })) });

  it('新建再插图（整块评审第 3 条）：新建的 save 之后，下一次 save 带 add_images 预登记（字节数取原图），再传 full、thumb；不再重拉列表', async () => {
    const { s, api, calls } = await unlocked();
    const row = newRow();
    s.store.put(row);
    s.queue.wrote(row, true);
    s.queue.addImage(row, pic);
    await settle();
    expect(vi.mocked(api.imageUpload).mock.calls.map((c) => [c[0].note_id, c[0].image_id, c[0].part])).toEqual([[NEW, IMG_NEW, 'full'], [NEW, IMG_NEW, 'thumb']]);
    const order = calls.map((c) => c.action);
    expect(order.slice(order.indexOf('save'))).toEqual(['save', 'save']);
    const saves = calls.flatMap((c) => (c.req.action === 'save' ? [c.req] : []));
    expect(saves.map((x) => x.add_images ?? null)).toEqual([null, [{ id: IMG_NEW, bytes: pic.full.size, width: 10, height: 20, has_thumb: true }]]);
    expect(s.store.getSnapshot()).toMatchObject({ uploads: new Map(), fresh: new Set() });
  });

  it('save 只发一次请求、不重拉列表', async () => {
    const { s, calls } = await unlocked();
    s.queue.wrote({ ...noteRowOf(note()), body: 'b' }, false);
    await settle();
    expect(calls.filter((c) => c.action === 'save')).toHaveLength(1);
    expect(calls.at(-1)?.action).toBe('save');
  });

  it('传图失败（服务忙）退避重传：同一个图片 id、同一条隐私记（不另生成），第二次成功', async () => {
    const { s, api } = await unlocked();
    vi.mocked(api.imageUpload).mockResolvedValueOnce({ ok: false, code: 'try_later' });
    const row = noteRowOf(note());
    s.queue.addImage(row, pic);
    await settle();
    const keys = vi.mocked(api.imageUpload).mock.calls.map((c) => `${c[0].note_id}/${c[0].image_id}`);
    expect(keys).toHaveLength(3);
    expect(new Set(keys)).toEqual(new Set([`${NID}/${IMG_NEW}`]));
    expect(s.store.getSnapshot().uploads.size).toBe(0);
  });

  it('传图时令牌过期（vault_locked）：先发 renew（不是 list_credentials）换新令牌再传', async () => {
    const { s, api, calls } = await unlocked({ renew: () => ({ ok: true, vault_token: TOK2, expires_at: 9e12 }) });
    vi.mocked(api.imageUpload).mockResolvedValueOnce({ ok: false, code: 'vault_locked' });
    s.queue.addImage(noteRowOf(note()), pic);
    await settle();
    expect(calls.map((c) => c.action)).toContain('renew');
    expect(calls.map((c) => c.action)).not.toContain('list_credentials');
    expect(vi.mocked(api.imageUpload).mock.calls[1]?.[2]).toBe(TOK2);
  });

  it('本机刚插的图直接进图片表（seedImage），显示不再经 vault-image 取；上锁一起撤销', async () => {
    const { s, api, revoked } = await unlocked();
    s.seedImage(IMG_NEW, pic.full, pic.thumb);
    expect(s.peekImage(IMG_NEW, 'thumb')).toBe('blob:x/2');
    expect(await s.image(IMG_NEW, 'full')).toBe('blob:x/1');
    expect(api.imageGet).not.toHaveBeenCalled();
    s.lock();
    expect(revoked.sort()).toEqual(['blob:x/1', 'blob:x/2']);
    expect(s.peekImage(IMG_NEW, 'full')).toBeNull();
  });

  it('移出隐私记：先等队列把这一条发完再 export；成了从仓库拿掉', async () => {
    const { s, calls } = await unlocked({ export: () => tokenOk });
    const row = { ...noteRowOf(note()), body: '改过' };
    s.store.put(row);
    s.queue.wrote(row, false);
    expect((await s.exportNote(NID)).ok).toBe(true);
    const order = calls.map((c) => c.action);
    expect(order.slice(order.indexOf('save'))).toEqual(['save', 'export']);
    expect(s.store.get(NID)).toBeUndefined();
  });

  it('importNote：锁着时也是走 run（vault_locked 会等解锁）；成功后已解锁才重新拉列表', async () => {
    const m = make({ import: () => tokenOk });
    await m.s.refreshStatus();
    expect((await m.s.importNote(NID)).ok).toBe(true);
    expect(m.calls.map((c) => c.action)).toEqual(['status', 'import']);
  });
});

describe('文档附件（vault-file，B4b-1）', () => {
  it('放了微软预览的临时副本：上锁时趁令牌还在先发 ms_preview_end；没放过的不发', async () => {
    const { s, api } = await unlocked();
    s.lock();
    expect(api.fileEnd).not.toHaveBeenCalled();
    const b = await unlocked();
    expect((await b.s.file.msPreview(NID)).ok).toBe(true);
    b.s.lock();
    expect(b.api.fileEnd).toHaveBeenCalledWith(TOK);
  });

  it('主动结束后不再重复发，上锁时也不再发', async () => {
    const { s, api } = await unlocked();
    await s.file.msPreview(NID);
    s.file.msPreviewEnd();
    s.file.msPreviewEnd();
    s.lock();
    expect(api.fileEnd).toHaveBeenCalledTimes(1);
  });

  it('请求在飞时预览就关了：先发一次 end；回来后调用方再 end，要真发出去（服务器可能是之后才放的副本）', async () => {
    const { s, api } = await unlocked();
    const p = s.file.msPreview(NID);
    s.file.msPreviewEnd();
    await p;
    s.file.msPreviewEnd();
    expect(api.fileEnd).toHaveBeenCalledTimes(2);
  });

  it('审查第 4 条：上锁时发过 end，之后再关预览不重复发', async () => {
    const { s, api } = await unlocked();
    await s.file.msPreview(NID);
    vi.mocked(api.fileEnd).mockResolvedValueOnce(false);
    s.lock();
    expect(api.fileEnd).toHaveBeenLastCalledWith(TOK);
    s.file.msPreviewEnd();
    expect(api.fileEnd).toHaveBeenCalledTimes(1);
  });

  it('11-18 评审加密组第 12 条：ms_preview 断网、超时、5xx（说不准服务器放没放副本）照旧当放了，关预览时发 end；服务器明确拒了不发', async () => {
    for (const [code, ends] of [['offline', 1], ['try_later', 1], ['unknown', 1], ['not_found', 0], ['rate_limited', 0]] as const) {
      const { s, api } = await unlocked();
      vi.mocked(api.fileCall).mockResolvedValueOnce({ ok: false, code } as VaultFail);
      expect((await s.file.msPreview(NID)).ok).toBe(false);
      s.file.msPreviewEnd();
      expect(api.fileEnd, code).toHaveBeenCalledTimes(ends);
    }
  });

  it('11-18 评审加密组第 9 条：已经锁着（没有令牌）取附件直接回 vault_locked，不白发 renew，也不把主动上锁翻成“等解锁”', async () => {
    const { s, api, calls } = await unlocked();
    s.lock();
    const before = calls.length;
    expect(await s.file.get(NID, 'full')).toEqual({ ok: false, code: 'vault_locked' });
    expect(calls.slice(before).map((c) => c.action)).toEqual([]);
    expect(api.fileGet).not.toHaveBeenCalled();
    expect(s.get().waiting).toBe(false);
  });

  it('审查第 4 条：end 没发成（令牌过期、断网）就记下，下次解锁后补发一次；发成了不补', async () => {
    const { s, api } = await unlocked();
    await s.file.msPreview(NID);
    vi.mocked(api.fileEnd).mockResolvedValueOnce(false);
    s.lock();
    await new Promise((r) => setTimeout(r, 0));
    expect(api.fileEnd).toHaveBeenCalledTimes(1);
    await s.unlock('1234');
    expect(api.fileEnd).toHaveBeenCalledTimes(2);
    expect(api.fileEnd).toHaveBeenLastCalledWith(TOK);
    await new Promise((r) => setTimeout(r, 0));
    s.lock();
    await s.unlock('1234');
    expect(api.fileEnd).toHaveBeenCalledTimes(2);
  });
});

describe('11-18 全 app 评审加密组第 2 条：导出用的令牌按本机时钟算过期，本机和服务器差 ±5 分钟也对', () => {
  const SKEW = 5 * 60_000;
  // 服务器按自己的钟签：now + 600 秒（续期封顶 12 小时，这里够不着）；本机钟 = 服务器钟 + skew
  async function withSkew(skew: number) {
    const clock = { ms: 2_000_000_000_000 };
    const server = (): number => clock.ms - skew;
    const tok = () => ({ ok: true, vault_token: TOK, expires_at: server() + VAULT_TOKEN_TTL_S * 1000 });
    const { api } = fakeApi({ status: () => statusSet, unlock: tok, list: () => ({ ...tok(), notes: [] }), renew: tok });
    const s = createVaultSession({ api, now: () => clock.ms, onToken: setVaultToken, sleep: async () => undefined });
    await s.refreshStatus();
    s.show(undefined, 'page');
    expect((await s.unlock('1234')).ok).toBe(true);
    return { s, clock };
  }

  for (const skew of [SKEW, -SKEW]) {
    it(`本机比服务器${skew > 0 ? '快' : '慢'} 5 分钟：拿到后 9 分钟内照带，满 10 分钟（服务器那边已过期）不再带`, async () => {
      const { clock } = await withSkew(skew);
      try {
        const t0 = clock.ms;
        expect(vaultToken(t0 + 6 * 60_000)).toBe(TOK);   // 原来本机快 5 分钟时这里已经当过期（只剩 5 分钟）
        expect(vaultToken(t0 + 9 * 60_000)).toBe(TOK);
        expect(vaultToken(t0 + 10 * 60_000)).toBeNull();  // 原来本机慢 5 分钟时这里还给（多给 5 分钟过期的令牌）
      } finally {
        setVaultToken(null, 0);
      }
    });
  }

  it('续期照样按本机发出请求的时刻往后算；上锁后不给', async () => {
    const { s, clock } = await withSkew(-SKEW);
    try {
      clock.ms += 6 * 60_000;
      s.touch();
      await new Promise((r) => setTimeout(r, 0));
      const t1 = clock.ms;
      expect(vaultToken(t1 + 9 * 60_000)).toBe(TOK);
      expect(vaultToken(t1 + 10 * 60_000)).toBeNull();
      s.lock();
      expect(vaultToken(t1)).toBeNull();
    } finally {
      setVaultToken(null, 0);
    }
  });

  it('从输密码起满 12 小时（服务器续期封顶）就不再给，续期也不往后延', async () => {
    const { s, clock } = await withSkew(SKEW);
    try {
      const t0 = clock.ms;
      for (let i = 0; i < 2 * 12; i++) {
        clock.ms += 6 * 60_000 * 5;   // 每 30 分钟续一次
        s.touch();
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(clock.ms - t0).toBe(12 * 3600_000);
      expect(vaultToken(clock.ms - 1000)).toBeNull();
      expect(vaultToken(t0 + 12 * 3600_000 - 6000)).toBe(TOK);
    } finally {
      setVaultToken(null, 0);
    }
  });
});

describe('锁着时数“里面有 N 条”（R-436 丁批）', () => {
  const A = '33333333-3333-4333-8333-333333333333';
  const B = '44444444-4444-4444-8444-444444444444';
  it('解锁拉过列表的 3 条，本机集合还没同步到：上锁后照样数 3 条（原来 0 条）', async () => {
    const { s } = await unlocked({ list: () => listOk([note(), note({ id: A }), note({ id: B })]) });
    expect(countVault([], true, s.store.getSnapshot())).toBe(3);
    s.lock();
    expect(s.store.getSnapshot().notes).toEqual([]);
    expect(countVault([], s.get().listed, s.store.getSnapshot())).toBe(3);
  });

  it('本机集合里已经同步到的不重复算；别处删掉了的（本机行 deleted_at）不算；普通随手记不算', async () => {
    const { s } = await unlocked({ list: () => listOk([note(), note({ id: A })]) });
    s.lock();
    const local = [
      { id: NID, is_private: true, deleted_at: null, undone: false },
      { id: A, is_private: true, deleted_at: 5, undone: false },
      { id: B, is_private: true, deleted_at: null, undone: false },
      { id: 'plain', is_private: false, deleted_at: null, undone: false },
    ];
    expect(countVault(local, false, s.store.getSnapshot())).toBe(2);
  });

  it('解锁期里移出、永久删除的（forget）上锁后不再算；连着锁两次不把记下的清空', async () => {
    const { s } = await unlocked({ list: () => listOk([note(), note({ id: A })]) });
    s.store.forget([A]);
    s.lock();
    s.lock();
    expect(countVault([], false, s.store.getSnapshot())).toBe(1);
  });

  it('从没解锁过：只数本机集合', () => {
    const { s } = make();
    expect(countVault([{ id: A, is_private: true, deleted_at: null, undone: false }], false, s.store.getSnapshot())).toBe(1);
  });
});
