// vault 的隐私记读写、永久删除、移进移出（B5 任务单 S5、S7；TC-B5-08、48 ④⑤、TC-B0-75 vault 移出写回 images 的契约）。
import { describe, expect, it } from 'vitest';
import { aesKeyFor, openNote } from '../../supabase/functions/_shared/vault-crypto.ts';
import { signVaultToken } from '../../supabase/functions/_shared/vault-token.ts';
import { A, B, call, MASTER, SECRET, unlocked, uuid, world, type World } from './vault-fakes.ts';

const N1 = uuid(1);
const N2 = uuid(2);
const I1 = uuid(11);
const I2 = uuid(12);
const webp = (n = 32) => { const b = new Uint8Array(n); b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]); return b; };
const key = (u: string, n: string, i: string, t = false) => `${u}/${n}/${i}${t ? '.t' : ''}.webp`;
const save = (id: string, extra: Record<string, unknown> = {}) => ({ action: 'save', id, title: '标题', body: '正文', category_id: null, created_at: 1, updated_at: 2, ...extra });

async function token(w: World) { return (await signVaultToken(SECRET, A, w.db.s.vault.get(A)?.pin_epoch ?? 0, w.db.ms)).token; }

describe('save、list（加密存、解密读）', () => {
  it('新建、改；库里只有密文、title/body 为空；list 解开；同 id 的普通随手记不让覆盖', async () => {
    const w = world();
    const tok = await unlocked(w);
    expect((await call(w, save(N1), { token: tok })).status).toBe(200);
    const row = w.db.s.notes.get(N1)!;
    expect(row).toMatchObject({ is_private: true, title: null, body: null, enc_key_id: 1 });
    expect(await openNote(await aesKeyFor(MASTER, A, 'note'), A, N1, 1, row.body_enc!)).toEqual({ v: 1, title: '标题', body: '正文' });
    await call(w, save(N1, { title: '新', updated_at: 3 }), { token: tok });
    const l = await call(w, { action: 'list' }, { token: tok });
    expect(l.body.notes).toEqual([{ id: N1, title: '新', body: '正文', category_id: null, created_at: 1, updated_at: 3, deleted_at: null, images: [] }]);
    w.db.plainNote(A, N2, 'p', 'q');
    expect((await call(w, save(N2), { token: tok })).body.error).toBe('not_found');
  });

  it('add_images 预登记图片行（skip / vault_off，按报的 bytes 算额度；不查 R2，整块评审第 3、10 条）；原样重发算成功', async () => {
    const w = world();
    const tok = await unlocked(w);
    const img = { id: I1, bytes: 40, width: 1, height: 1, has_thumb: true };
    expect((await call(w, save(N1, { add_images: [img] }), { token: tok })).status).toBe(200);   // 新建这条和登记图在同一次
    expect(w.db.s.images.get(I1)).toMatchObject({ note_id: N1, bucket: 'vault-images', bytes: 40, has_thumb: true, ai_status: 'skip', skip_reason: 'vault_off', taken_at: null });
    expect(w.r2.keys('vault-images')).toEqual([]);
    expect((await call(w, save(N1, { add_images: [img], updated_at: 3 }), { token: tok })).status).toBe(200);
    expect([...w.db.s.images.values()].filter((i) => i.note_id === N1)).toHaveLength(1);
  });

  it('add_images 撞上已有的 id（整块评审第 12 条）：字节数、有无缩略图对不上，或那一行在别的随手记、别人名下，一律 400、什么都不写', async () => {
    const w = world();
    const tok = await unlocked(w);
    const img = { id: I1, bytes: 40, width: 1, height: 1, has_thumb: false };
    await call(w, save(N1, { add_images: [img] }), { token: tok });
    for (const bad of [{ ...img, bytes: 41 }, { ...img, has_thumb: true }]) {
      const r = await call(w, save(N1, { title: '改了', add_images: [bad], updated_at: 5 }), { token: tok });
      expect([r.status, r.body.error]).toEqual([400, 'bad_request']);
    }
    // 同一个 id 拿去登记到另一条：插不进，整个事务回滚（N2 没建出来）
    const r = await call(w, save(N2, { add_images: [img] }), { token: tok });
    expect([r.status, r.body.error]).toEqual([400, 'bad_request']);
    expect(w.db.s.notes.has(N2)).toBe(false);
    const l = await call(w, { action: 'list' }, { token: tok });
    expect(l.body.notes.map((n: { title: string }) => n.title)).toEqual(['标题']);
  });

  it('remove_images 软删，事务提交后删掉 R2 里的原图和缩略图（整块评审第 2 条）；删失败只记 image_drop_failed', async () => {
    const w = world();
    const tok = await unlocked(w);
    await call(w, save(N1, { add_images: [{ id: I1, bytes: 32, width: 1, height: 1, has_thumb: true }, { id: I2, bytes: 32, width: 1, height: 1, has_thumb: false }] }), { token: tok });
    for (const k of [key(A, N1, I1), key(A, N1, I1, true), key(A, N1, I2)]) await w.r2.put('vault-images', k, webp(32), { contentType: 'image/webp' });
    await call(w, save(N1, { remove_images: [I1] }), { token: tok });
    expect(w.db.s.images.get(I1)?.deleted_at).toBe(w.db.ms);
    expect(w.r2.keys('vault-images')).toEqual([`vault-images/${key(A, N1, I2)}`]);
    w.r2.deleteMany = async () => { throw new Error('r2'); };
    await call(w, save(N1, { remove_images: [I2] }), { token: tok });
    expect(w.logs).toContain('image_drop_failed');
    expect(w.db.s.images.get(I2)?.deleted_at).toBe(w.db.ms);
  });

  it('delete、undelete；解不开的那条不回、记 decrypt_failed', async () => {
    const w = world();
    const tok = await unlocked(w);
    await call(w, save(N1), { token: tok });
    await call(w, { action: 'delete', id: N1 }, { token: tok });
    expect(w.db.s.notes.get(N1)?.deleted_at).toBe(w.db.ms);
    await call(w, { action: 'undelete', id: N1 }, { token: tok });
    expect(w.db.s.notes.get(N1)?.deleted_at).toBeNull();
    w.db.s.notes.get(N1)!.body_enc = new Uint8Array(40);
    expect((await call(w, { action: 'list' }, { token: tok })).body.notes).toEqual([]);
    expect(w.logs).toContain('decrypt_failed');
  });
});

describe('purge（TC-B5-48 ④⑤）', () => {
  it('不带、过期、reset 后的旧令牌都拒；有效令牌只删本人已删的隐私记', async () => {
    const w = world();
    const tok = await unlocked(w);
    await unlocked(w, B);
    await call(w, save(N1), { token: tok });
    await call(w, { action: 'delete', id: N1 }, { token: tok });
    await call(w, save(N2), { token: tok });                         // 没删的隐私记
    const VB = uuid(3);
    w.db.s.notes.set(VB, { ...w.db.s.notes.get(N1)!, id: VB, user_id: B });   // B 已删的隐私记
    const P = uuid(4);
    w.db.plainNote(A, P, 'x', 'y');
    w.db.s.notes.get(P)!.deleted_at = 1;                              // A 已删的普通随手记
    const items = [N1, N2, VB, P];
    expect((await call(w, { action: 'purge', items })).body.error).toBe('vault_locked');
    const late = await token(w);
    w.db.ms += 601_000;
    expect((await call(w, { action: 'purge', items }, { token: late })).body.error).toBe('vault_locked');
    const before = await token(w);
    await call(w, { action: 'reset', new_pin: '5555' });
    expect((await call(w, { action: 'purge', items }, { token: before })).body.error).toBe('vault_relock');
    const ok = await call(w, { action: 'purge', items }, { token: await token(w) });
    expect(ok.body.purged).toBe(1);
    expect([...w.db.s.notes.keys()].sort()).toEqual([N2, VB, P].sort());
  });

  it('永久删除后删掉那几条的 R2 对象（原图、缩略图；整块评审第 2 条）；没删成的那条（还没软删）的对象不动', async () => {
    const w = world();
    const tok = await unlocked(w);
    await call(w, save(N1, { add_images: [{ id: I1, bytes: 32, width: 1, height: 1, has_thumb: true }] }), { token: tok });
    await call(w, save(N2, { add_images: [{ id: I2, bytes: 32, width: 1, height: 1, has_thumb: false }] }), { token: tok });
    for (const k of [key(A, N1, I1), key(A, N1, I1, true), key(A, N2, I2)]) await w.r2.put('vault-images', k, webp(32), { contentType: 'image/webp' });
    await call(w, { action: 'delete', id: N1 }, { token: tok });
    const r = await call(w, { action: 'purge', items: [N1, N2] }, { token: tok });
    expect(r.body.purged).toBe(1);
    expect(w.r2.keys('vault-images')).toEqual([`vault-images/${key(A, N2, I2)}`]);
  });
});

describe('移进、移出（TC-B5-08、TC-B0-75）', () => {
  async function setupPlain() {
    const w = world();
    const tok = await unlocked(w);
    w.db.plainNote(A, N1, '明文标题', '明文正文', [{ id: I1, has_thumb: true, taken_at: 5 }, { id: I2 }]);
    w.db.s.vectors.add(`${A}|note|${N1}`).add(`${A}|image|${I1}`);
    for (const [i, t] of [[I1, false], [I1, true], [I2, false]] as const) await w.r2.put('images', key(A, N1, i, t), webp(), { contentType: 'image/webp' });
    w.r2.puts.length = 0;
    return { w, tok };
  }

  it('import：明文列全清、只剩密文；图片换到 vault-images（清 taken_at、ai_desc）；旧向量删；旧桶对象删', async () => {
    const { w, tok } = await setupPlain();
    const r = await call(w, { action: 'import', note_id: N1 }, { token: tok });
    expect(r.status).toBe(200);
    expect(typeof r.body.vault_token).toBe('string');
    expect(w.db.s.notes.get(N1)).toMatchObject({ is_private: true, title: null, body: null, raw_text: '', tags: [], ai_meta: null, converted_to: null });
    expect(w.db.s.images.get(I1)).toMatchObject({ bucket: 'vault-images', taken_at: null, ai_desc: null, ai_status: 'skip' });
    expect(w.db.s.vectors.size).toBe(0);
    expect(w.r2.keys('images')).toEqual([]);
    expect(w.r2.keys('vault-images')).toHaveLength(3);
    expect(w.r2.puts.every((p) => p.contentType === 'image/webp')).toBe(true);
    const l = await call(w, { action: 'list' }, { token: tok });
    expect((l.body.notes as { title: string }[])[0]?.title).toBe('明文标题');
  });

  it('export：写回 images 桶，put 一律 contentType image/webp（TC-B0-75 契约）；明文回来、密文清空', async () => {
    const { w, tok } = await setupPlain();
    await call(w, { action: 'import', note_id: N1 }, { token: tok });
    w.r2.puts.length = 0;
    const r = await call(w, { action: 'export', note_id: N1 }, { token: tok });
    expect(r.status).toBe(200);
    expect(w.r2.puts.map((p) => [p.bucket, p.contentType])).toEqual([['images', 'image/webp'], ['images', 'image/webp'], ['images', 'image/webp']]);
    expect(w.db.s.notes.get(N1)).toMatchObject({ is_private: false, title: '明文标题', body: '明文正文', body_enc: null });
    expect(w.db.s.images.get(I1)).toMatchObject({ bucket: 'images', ai_status: 'pending' });
    expect(w.r2.keys('vault-images')).toEqual([]);
  });

  it('已软删的图片行跟着换桶，对象也跟着搬（整块评审第 7 条）', async () => {
    const { w, tok } = await setupPlain();
    w.db.s.images.get(I2)!.deleted_at = 7;
    expect((await call(w, { action: 'import', note_id: N1 }, { token: tok })).status).toBe(200);
    expect(w.db.s.images.get(I2)).toMatchObject({ bucket: 'vault-images', deleted_at: 7 });
    expect(w.r2.keys('vault-images')).toContain(`vault-images/${key(A, N1, I2)}`);
    expect(w.r2.keys('images')).toEqual([]);
  });

  it('带附件回 has_files；不是本人的回 not_found；不带令牌拒', async () => {
    const { w, tok } = await setupPlain();
    w.db.s.files.set(uuid(9), { user_id: A, note_id: N1 });
    expect((await call(w, { action: 'import', note_id: N1 }, { token: tok })).body.error).toBe('has_files');
    expect((await call(w, { action: 'import', note_id: uuid(8) }, { token: tok })).body.error).toBe('not_found');
    expect((await call(w, { action: 'import', note_id: N1 })).body.error).toBe('vault_locked');
    expect(w.r2.puts).toEqual([]);
  });

  it('提交失败：新桶里刚写的对象删掉、旧桶和行都不动；上次做到一半（对象已在）算成功', async () => {
    const { w, tok } = await setupPlain();
    const run = w.db.run.bind(w.db);
    let n = 0;
    w.deps.tx = (uid, fn) => (++n === 3 ? Promise.reject(new Error('commit')) : run(uid, fn));   // 第 1 次验令牌、第 2 次准备、第 3 次提交
    expect((await call(w, { action: 'import', note_id: N1 }, { token: tok })).status).toBe(503);
    expect(w.r2.keys('vault-images')).toEqual([]);
    expect(w.r2.keys('images')).toHaveLength(3);
    expect(w.db.s.notes.get(N1)?.is_private).toBe(false);
    w.deps.tx = run;
    await w.r2.put('vault-images', key(A, N1, I1), webp(), { contentType: 'image/webp' });
    expect((await call(w, { action: 'import', note_id: N1 }, { token: tok })).status).toBe(200);
    expect(w.r2.keys('vault-images')).toHaveLength(3);
  });

  // 11-14 独立评审 S2：同一条并发移进两次。后到的 B 先在②写好了对象，先提交的 A 在②碰到“对象已经在”算成功、提交后指着的正是 B 写的对象
  async function racing(thenFail: boolean) {
    const { w, tok } = await setupPlain();
    const run = w.db.run.bind(w.db);
    let n = 0;
    let first: Awaited<ReturnType<typeof call>> | null = null;
    w.deps.tx = async (uid, fn) => {
      if (++n === 3) {   // B 的第 3 次事务（提交）之前，A 从头到尾做完一次
        w.deps.tx = run;
        first = await call(w, { action: 'import', note_id: N1 }, { token: tok });
        if (thenFail) throw new Error('commit');
      }
      return run(uid, fn);
    };
    const second = await call(w, { action: 'import', note_id: N1 }, { token: tok });
    return { w, tok, first: first as unknown as Awaited<ReturnType<typeof call>>, second };
  }

  it('并发移进两次、先提交的那次指着后到那次写的对象：后到的回 404，但不删新桶里的对象', async () => {
    const { w, tok, first, second } = await racing(false);
    expect(first.status).toBe(200);
    expect([second.status, second.body.error]).toEqual([404, 'not_found']);
    expect(w.r2.keys('vault-images')).toHaveLength(3);
    expect(w.r2.keys('images')).toEqual([]);
    const l = await call(w, { action: 'list' }, { token: tok });
    expect((l.body.notes as { images: unknown[] }[])[0]?.images).toHaveLength(2);
  });

  it('同上，后到的那次提交时抛错：另开事务看到已经移进了，也不删', async () => {
    const { w, first, second } = await racing(true);
    expect(first.status).toBe(200);
    expect(second.status).toBe(503);
    expect(w.r2.keys('vault-images')).toHaveLength(3);
  });
});
