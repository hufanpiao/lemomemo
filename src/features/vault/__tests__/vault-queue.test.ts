// 隐私记内存仓库（data/vault-store.ts）和后台发送队列（data/vault-queue.ts）：B5 隐私记重写（主持人 11-15 定稿）
// • 按条合并、发前读最新值、同一条两次 save 至少隔 1.5 秒
// • 带图：save 预登记 → 原图 → 缩略图；传成了“上传中”去掉
// • 失败按落法分：retry 退避 2/5/15 秒三次再标 failed、online 再试；message 直接 failed；unlock（取消解锁）整个丢掉并记个数
// • 上锁丢掉时在飞的那次回来不再动；解锁拉完列表 overlay 把本机还没发完的盖回去；撤销没发出去的新建
// • 永久删除成了（forget）：撤掉这条的任务和“没保存上”标记，在飞的那次回来不再动
import { describe, expect, it } from 'vitest';
import type { VaultResult } from '../data/vault-api.ts';
import { createVaultQueue, limiter, QUEUE_BACKOFF, SAVE_GAP_MS, type SaveReq } from '../data/vault-queue.ts';
import { createVaultStore, noteRowOf, type Row } from '../data/vault-store.ts';
import { held as heldReq, IMG, NID, note } from './session-fakes.ts';

const OK: VaultResult<unknown> = { ok: true, value: true };

type Reply = VaultResult<unknown> | Promise<VaultResult<unknown>>;

function harness(o: { save?: (r: SaveReq) => Reply; del?: () => Reply; upload?: (part: string) => Reply; sleep?: (ms: number) => Promise<void> } = {}) {
  const store = createVaultStore();
  const calls: string[] = [];
  const saves: SaveReq[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const seeded: string[] = [];
  const clock = { ms: 10_000 };
  const q = createVaultQueue({
    store,
    save: async (r) => {
      calls.push('save');
      saves.push(r);
      return o.save ? o.save(r) : OK;
    },
    setDeleted: async (_id, d) => {
      calls.push(d ? 'delete' : 'undelete');
      return o.del ? o.del() : OK;
    },
    upload: async (_n, _i, part) => {
      calls.push(part);
      return o.upload ? o.upload(part) : OK;
    },
    seed: (id) => seeded.push(id),
    reload: () => calls.push('reload'),
    now: () => clock.ms,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (o.sleep) return o.sleep(ms);
      clock.ms += ms;
    },
    log: (l) => logs.push(l),
  });
  return { store, q, calls, saves, sleeps, logs, seeded, clock };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

const held = () => heldReq<VaultResult<unknown>>();

const row = (body: string): Row => ({ ...noteRowOf(note()), body });

describe('内存仓库', () => {
  it('解锁 list 放进来是随手记集合那种行；上锁清空，没来得及保存的个数留到看过为止', () => {
    const s = createVaultStore();
    s.load([note({ images: [{ id: IMG, has_thumb: true, width: 10, height: 6, bytes: 100, deleted_at: null }] })]);
    const snap = s.getSnapshot();
    expect(snap.notes[0]).toMatchObject({ id: NID, title: '体检报告', is_private: false, category_source: 'manual', deleted_at: null });
    expect(snap.images[0]).toMatchObject({ id: IMG, note_id: NID, bucket: 'images', has_thumb: true });
    expect(s.getSnapshot()).toBe(snap);
    s.patch(NID, { body: '改了' });
    expect(s.get(NID)?.['body']).toBe('改了');
    s.addDropped(2);
    s.clear();
    expect(s.getSnapshot()).toMatchObject({ notes: [], images: [], dropped: 2 });
    s.ackDropped();
    expect(s.getSnapshot().dropped).toBe(0);
  });

  it('forget 连图一起拿掉', () => {
    const s = createVaultStore();
    s.load([note({ images: [{ id: IMG, has_thumb: false, width: null, height: null, bytes: 1, deleted_at: null }] })]);
    s.forget([NID]);
    expect(s.getSnapshot()).toMatchObject({ notes: [], images: [] });
  });
});

describe('发送队列', () => {
  it('按条合并、发前读最新值：在飞时又改了两次，回来只再发一次最新的，和上一次至少隔 1.5 秒', async () => {
    const first = held();
    let n = 0;
    const h = harness({ save: () => (++n === 1 ? first.p : OK) });
    h.q.wrote(row('一'), true);
    h.q.wrote(row('二'), true);
    h.q.wrote(row('三'), true);
    await settle();
    expect(h.saves.map((r) => r.body)).toEqual(['一']);
    first.release(OK);
    await settle();
    expect(h.saves.map((r) => r.body)).toEqual(['一', '三']);
    expect(h.sleeps).toEqual([SAVE_GAP_MS]);
    expect(h.q.size()).toBe(0);
  });

  it('带图：save 带 add_images 预登记 → 原图 → 缩略图；传成了“上传中”去掉', async () => {
    const h = harness();
    h.store.put(row('正文'));
    h.q.addImage(row('正文'), { id: IMG, full: new Blob(['full']), thumb: new Blob(['t']), width: 10, height: 6 });
    expect(h.store.getSnapshot().uploads.get(IMG)).toBe('uploading');
    await settle();
    expect(h.calls).toEqual(['save', 'full', 'thumb']);
    expect(h.saves[0]?.add_images).toEqual([{ id: IMG, bytes: 4, width: 10, height: 6, has_thumb: true }]);
    expect(h.store.getSnapshot().uploads.has(IMG)).toBe(false);
  });

  it('空间满了（负责人 11-25“要，和随手记一样弹”）：带新图的 save 回 too_large → 图标没传上、通知一次这一条；不带图的 too_large 不通知', async () => {
    const h = harness({ save: () => ({ ok: false, code: 'too_large' }) });
    const hits: string[] = [];
    const off = h.q.onQuota((id) => hits.push(id));
    h.store.put(row('正文'));
    h.q.addImage(row('正文'), { id: IMG, full: new Blob(['f']), thumb: null, width: 1, height: 1 });
    await settle();
    expect(h.calls).toEqual(['save']);
    expect(hits).toEqual([NID]);
    expect(h.store.getSnapshot().uploads.get(IMG)).toBe('failed');
    expect(h.store.getSnapshot().failed.has(NID)).toBe(true);
    off();
    // 只改正文的 save 回 too_large（不是插图）：照旧只标没保存上，不出“空间满了”
    const h2 = harness({ save: () => ({ ok: false, code: 'too_large' }) });
    const hits2: string[] = [];
    h2.q.onQuota((id) => hits2.push(id));
    h2.q.wrote(row('很长的正文'), false);
    await settle();
    expect(hits2).toEqual([]);
    expect(h2.store.getSnapshot().failed.has(NID)).toBe(true);
  });

  it('删一张还没登记的图就地丢掉；登记过的下次 save 带 remove_images', async () => {
    const h = harness();
    const r = row('x');
    h.q.removeImage(r, IMG);
    await settle();
    expect(h.saves[0]?.remove_images).toEqual([IMG]);
    const h2 = harness();
    const gate = held();
    h2.q.wrote(r, false);
    h2.q.addImage(r, { id: IMG, full: new Blob(['f']), thumb: null, width: 1, height: 1 });
    h2.q.removeImage(r, IMG);
    await settle();
    expect(h2.calls).toEqual(['save']);
    expect(h2.saves[0]?.add_images).toBeUndefined();
    expect(h2.saves[0]?.remove_images).toBeUndefined();
    gate.release(OK);
  });

  it('H3：预登记这张图的 save 在路上时删了它：save 回来后再发一次 save 带 remove_images，不传字节', async () => {
    const g = held();
    let n = 0;
    const h = harness({ save: () => (++n === 1 ? g.p : OK) });
    const r = row('x');
    h.q.addImage(r, { id: IMG, full: new Blob(['f']), thumb: null, width: 1, height: 1 });
    await settle();
    expect(h.saves[0]?.add_images?.map((a) => a.id)).toEqual([IMG]);
    h.q.removeImage(r, IMG);
    g.release(OK);
    await settle();
    expect(h.calls).toEqual(['save', 'save']);
    expect(h.saves[1]?.remove_images).toEqual([IMG]);
    expect(h.q.size()).toBe(0);
  });

  it('断网：2、5、15 秒退避三次，再不行标“没保存上”；网络回来再试，成了去掉标记', async () => {
    let fail = true;
    const h = harness({ save: () => (fail ? { ok: false, code: 'offline' } : OK) });
    h.q.wrote(row('断网写的'), true);
    await settle();
    expect(h.saves).toHaveLength(4);
    expect(h.sleeps).toEqual([...QUEUE_BACKOFF]);
    expect(h.store.getSnapshot().failed.has(NID)).toBe(true);
    fail = false;
    h.q.retryAll();
    await settle();
    expect(h.saves).toHaveLength(5);
    expect(h.saves[4]?.body).toBe('断网写的');
    expect(h.store.getSnapshot().failed.has(NID)).toBe(false);
    expect(h.logs.join('\n')).not.toContain('断网写的');
  });

  it('M4：一条在退避等着时别的条照发、flush 不被拖住；retryAll 立即重发，不等退避睡完', async () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    let fail = true;
    const h = harness({
      save: (r) => (r.id === NID && fail ? { ok: false, code: 'offline' } : OK),
      sleep: () => new Promise(() => undefined),   // 退避一直睡着
    });
    h.q.wrote(row('断网的那条'), true);
    await settle();
    expect(h.saves).toHaveLength(1);
    h.q.wrote({ ...row('另一条'), id: OTHER }, true);
    expect(await h.q.flush(OTHER)).toBe(true);
    expect(h.saves.map((r) => r.id)).toEqual([NID, OTHER]);
    fail = false;
    h.q.retryAll();
    await settle();
    expect(h.saves.map((r) => r.id)).toEqual([NID, OTHER, NID]);
    expect(h.q.size()).toBe(0);
  });

  it('not_found 这类只提示的码：直接标“没保存上”，不退避', async () => {
    const h = harness({ save: () => ({ ok: false, code: 'not_found' }) });
    h.q.wrote(row('x'), false);
    await settle();
    expect(h.saves).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(h.store.getSnapshot().failed.has(NID)).toBe(true);
  });

  it('只拖了顺序（R-429）：save 带 base_updated_at；回 stale 丢掉这一笔、记一次 stale、重新拉列表，不标没保存上', async () => {
    const h = harness({ save: () => ({ ok: false, code: 'stale' }) });
    h.q.wrote({ ...row('x'), sort_key: '17', updated_at: 5 }, false, ['sort_key']);
    await settle();
    expect(h.saves[0]).toMatchObject({ sort_key: '17', updated_at: 5, base_updated_at: 5 });
    expect(h.calls).toEqual(['save', 'reload']);
    expect(h.store.getSnapshot()).toMatchObject({ stale: 1 });
    expect(h.store.getSnapshot().failed.has(NID)).toBe(false);
    expect(h.q.has(NID)).toBe(false);
    h.store.ackStale();
    expect(h.store.getSnapshot().stale).toBe(0);
  });

  it('R-429 评审第 3 条：只改正文的 save 不带 sort_key（交给服务器保留密文里的，不把别的设备刚拖好的位置盖回去）；拖过顺序的才带', async () => {
    const h = harness();
    h.q.wrote({ ...row('改正文'), sort_key: '旧位置' }, false, ['body']);
    await settle();
    expect(h.saves[0]).not.toHaveProperty('sort_key');
    h.q.wrote({ ...row('改正文'), sort_key: '9' }, false, ['sort_key']);
    await settle();
    expect(h.saves[1]).toMatchObject({ sort_key: '9' });
    // 拖了顺序、还没发出去时又改了正文：合并成一份，排序值照样带上
    const first = held();
    let n = 0;
    const g = harness({ save: () => (++n === 1 ? first.p : OK) });
    g.q.wrote(row('a'), false, ['body']);
    await settle();
    g.q.wrote({ ...row('a'), sort_key: '5' }, false, ['sort_key']);
    g.q.wrote({ ...row('b'), sort_key: '5' }, false, ['body']);
    first.release(OK);
    await settle();
    expect(g.saves[0]).not.toHaveProperty('sort_key');
    expect(g.saves[1]).toMatchObject({ body: 'b', sort_key: '5' });
    expect(g.saves[1]?.base_updated_at).toBeUndefined();
    // 新建的照带（服务器上还没有这一条）
    const k = harness();
    k.q.wrote({ ...row('新'), sort_key: null }, true);
    await settle();
    expect(k.saves[0]).toHaveProperty('sort_key', null);
  });

  it('拖动那一笔在路上时又改了正文：stale 回来不丢，马上不带 base 重发正文；新建不带 base（照旧后写的算数）', async () => {
    const first = held();
    let n = 0;
    const h = harness({ save: () => (++n === 1 ? first.p : OK) });
    h.q.wrote(row('x'), false, ['sort_key']);
    await settle();
    h.q.wrote(row('改了'), false, ['body']);
    first.release({ ok: false, code: 'stale' });
    await settle();
    expect(h.saves.map((s) => [s.body, s.base_updated_at])).toEqual([['x', expect.any(Number)], ['改了', undefined]]);
    expect(h.calls).not.toContain('reload');
    expect(h.store.getSnapshot().stale).toBe(0);
    const g = harness();
    g.q.wrote(row('新'), true, ['sort_key']);
    await settle();
    expect(g.saves[0]?.base_updated_at).toBeUndefined();
  });

  it('令牌过期（会话上锁时 pause，save 回 vault_locked）：这一条原样留着不退避；resume 后整条重发', async () => {
    let locked = true;
    const h = harness({ save: () => (locked ? { ok: false, code: 'vault_locked' } : OK) });
    h.q.wrote(row('a'), true);
    h.q.pause();
    await settle();
    expect(h.q.size()).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.store.getSnapshot().failed.has(NID)).toBe(false);
    locked = false;
    h.q.resume();
    await settle();
    expect(h.saves.map((r) => r.body)).toEqual(['a', 'a']);
    expect(h.q.size()).toBe(0);
  });

  it('取消解锁、主动上锁（会话调 dropAll）：整个队列丢掉、记下个数和一行 vault queue drop', () => {
    const h = harness({ save: () => new Promise(() => undefined) });
    h.q.wrote(row('a'), true);
    h.q.wrote({ ...row('b'), id: IMG }, true);
    expect(h.q.dropAll('cancel')).toBe(2);
    expect(h.store.getSnapshot().dropped).toBe(2);
    expect(h.logs).toContain('vault queue drop n=2 why=cancel');
  });

  it('上锁丢掉时在飞的那次晚回来：什么都不做，不再发下一步', async () => {
    const g = held();
    const h = harness({ save: () => g.p });
    h.q.addImage(row('x'), { id: IMG, full: new Blob(['f']), thumb: null, width: 1, height: 1 });
    await settle();
    expect(h.q.dropAll('lock')).toBe(1);
    g.release(OK);
    await settle();
    expect(h.calls).toEqual(['save']);
  });

  it('图传失败（服务忙）退避重试；too_large 标没传上，retryImage 再传', async () => {
    let n = 0;
    const h = harness({ upload: () => (++n === 1 ? { ok: false, code: 'try_later' } : n === 2 ? { ok: false, code: 'too_large' } : OK) });
    h.q.addImage(row('x'), { id: IMG, full: new Blob(['f']), thumb: null, width: 1, height: 1 });
    await settle();
    expect(h.sleeps).toEqual([QUEUE_BACKOFF[0]]);
    expect(h.store.getSnapshot().uploads.get(IMG)).toBe('failed');
    expect(h.q.retryImage(IMG)).toBe(true);
    await settle();
    expect(h.calls).toEqual(['save', 'full', 'full', 'full']);
    expect(h.store.getSnapshot().uploads.has(IMG)).toBe(false);
    expect(h.q.retryImage(IMG)).toBe(false);
  });

  it('删除、撤销删除排在内容后面发', async () => {
    const h = harness();
    h.q.wrote(row('x'), false);
    h.q.deleted({ ...row('x'), deleted_at: 5 }, true);
    await settle();
    expect(h.calls).toEqual(['save', 'delete']);
  });

  it('撤销还没发出去的新建：拿掉；已经在发的不行', async () => {
    const g = held();
    const h = harness({ save: () => g.p });
    h.q.wrote(row('x'), true);
    expect(h.q.discard(NID)).toBe(false);
    g.release(OK);
    await settle();
    const h2 = harness();
    const big = held();
    h2.q.wrote({ ...row('先占着'), id: IMG }, true);
    h2.q.wrote(row('新建的'), true);
    expect(h2.q.discard(NID)).toBe(true);
    big.release(OK);
    await settle();
    expect(h2.saves.map((r) => r.body)).toEqual(['先占着']);
  });

  it('永久删除成了（forget）：没保存上的这条撤掉任务和标记，retryAll 也不再发', async () => {
    const h = harness({ save: () => ({ ok: false, code: 'not_found' }) });
    h.q.addImage(row('x'), { id: IMG, full: new Blob(['f']), thumb: null, width: 1, height: 1 });
    await settle();
    expect(h.store.getSnapshot().failed.has(NID)).toBe(true);
    h.q.forget([NID]);
    const snap = h.store.getSnapshot();
    expect(snap.failed.has(NID)).toBe(false);
    expect(snap.uploads.has(IMG)).toBe(false);
    expect(h.q.has(NID)).toBe(false);
    h.q.retryAll();
    await settle();
    expect(h.saves).toHaveLength(1);
  });

  it('永久删除时这条正在发：在飞的那次失败回来也不标“没保存上”、不再发', async () => {
    const g = held();
    const h = harness({ save: () => g.p });
    h.q.wrote(row('x'), true);
    await settle();
    h.q.forget([NID]);
    expect(h.store.getSnapshot().fresh.has(NID)).toBe(false);
    g.release({ ok: false, code: 'not_found' });
    await settle();
    expect(h.store.getSnapshot().failed.has(NID)).toBe(false);
    expect(h.calls).toEqual(['save']);
  });

  it('解锁拉完列表：本机还没发完的那一份盖回仓库（图片地址补放、没保存上的标记补回）', async () => {
    const h = harness({ save: () => ({ ok: false, code: 'not_found' }) });
    h.q.addImage(row('本机改的'), { id: IMG, full: new Blob(['f']), thumb: null, width: 1, height: 1 });
    await settle();
    h.store.clear();
    h.store.load([note()]);
    h.q.overlay();
    const snap = h.store.getSnapshot();
    expect(snap.notes[0]?.['body']).toBe('本机改的');
    expect(snap.images.map((r) => r.id)).toEqual([IMG]);
    expect(snap.uploads.get(IMG)).toBe('failed');
    expect(snap.failed.has(NID)).toBe(true);
    expect(h.seeded).toEqual([IMG]);
  });

  it('flush：发完回 true，没保存上回 false', async () => {
    const h = harness();
    expect(await h.q.flush(NID)).toBe(true);
    h.q.wrote(row('x'), false);
    expect(await h.q.flush(NID)).toBe(true);
    const bad = harness({ save: () => ({ ok: false, code: 'bad_request' }) });
    bad.q.wrote(row('x'), false);
    expect(await bad.q.flush(NID)).toBe(false);
  });
});

describe('limiter', () => {
  it('同时最多 2 个', async () => {
    const run = limiter(2);
    let live = 0;
    let peak = 0;
    const gates = [held(), held(), held()];
    const all = gates.map((g) =>
      run(async () => {
        live += 1;
        peak = Math.max(peak, live);
        await g.p;
        live -= 1;
      }),
    );
    await settle();
    expect(live).toBe(2);
    gates.forEach((g) => g.release(OK));
    await Promise.all(all);
    expect(peak).toBe(2);
  });
});
