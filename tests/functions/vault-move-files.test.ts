// vault 移进移出带文档附件（B4b-1；架构 5.13 第 11 点；原来回 409 has_files，代定 D13）：
//   移进时附件加密搬进 vault-files、名字和文字加密、sha256 换 HMAC；移出时解密写回 files、核对 HMAC；还在检查的回 try_later；
//   提交失败删新对象；并发移进时按已提交行的数据密钥重封对象。只用 vault-fakes.ts 的内存假库和假 R2。
import { describe, expect, it } from 'vitest';
import { openPart, openText, sha256Hex, shaMac, unwrapDek, wrapDek } from '../../supabase/functions/_shared/vault-files.ts';
import { A, B, call, MASTER, unlocked, uuid, world, type World } from './vault-fakes.ts';

const N1 = uuid(1);
const webp = (n = 32) => { const b = new Uint8Array(n); b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]); return b; };

describe('移进、移出带文档附件（B4b-1）', () => {
  async function setupPlain() {
    const w = world();
    const tok = await unlocked(w);
    w.db.plainNote(A, N1, '明文标题', '明文正文');
    w.r2.puts.length = 0;
    return { w, tok };
  }

  const F1 = uuid(21);
  const PDF = new TextEncoder().encode('%PDF-1.7 fake body for move test');
  const THUMB = webp(40);
  const fkey = (n: string, f: string) => `${A}/${n}/${f}.pdf`;
  const tkey = (n: string, f: string) => `${A}/${n}/${f}.t.webp`;

  async function withFile() {
    const x = await setupPlain();
    x.w.db.plainFile(A, N1, F1, { name: '合同.pdf', text: '抽出的文字', sha256: await sha256Hex(PDF), has_thumb: true });
    x.w.db.s.vectors.add(`${A}|file|${F1}`);
    x.w.db.s.vaultAi.add(`${A}|${F1}`);
    await x.w.r2.put('files', fkey(N1, F1), PDF, { contentType: 'application/pdf' });
    await x.w.r2.put('files', tkey(N1, F1), THUMB, { contentType: 'image/webp' });
    x.w.r2.puts.length = 0;
    return x;
  }
  /** 按库里那一行的数据密钥解开 vault-files 里的对象 */
  async function openStored(w: World, k: string, part: 'file' | 'thumb') {
    const f = w.db.s.files.get(F1)!;
    const dek = await unwrapDek(MASTER, A, F1, f.dek_enc!);
    const o = w.r2.objs.get(`vault-files/${k}`);
    return dek && o ? openPart(dek, A, F1, part, o.bytes) : null;
  }

  it('带附件移进：明文列和 AI 描述清空、文件名和文字加密、sha256 换成 HMAC；对象加密搬进 vault-files（octet-stream），files 里删掉；附件向量和 vault_ai 删', async () => {
    const { w, tok } = await withFile();
    expect((await call(w, { action: 'import', note_id: N1 }, { token: tok })).status).toBe(200);
    const f = w.db.s.files.get(F1)!;
    expect(f).toMatchObject({ is_vault: true, name: null, text_excerpt: null, ai_desc: null, ai_tags: [], ai_status: 'skip', skip_reason: 'vault_off', enc_key_id: 1, check_status: 'ok' });
    expect(f.sha256).toBe(await shaMac(MASTER, A, await sha256Hex(PDF)));
    const dek = (await unwrapDek(MASTER, A, F1, f.dek_enc!))!;
    expect(await openText(dek, A, F1, 'name', f.name_enc!)).toBe('合同.pdf');
    expect(await openText(dek, A, F1, 'text', f.text_enc!)).toBe('抽出的文字');
    expect(await openStored(w, fkey(N1, F1), 'file')).toEqual(PDF);
    expect(await openStored(w, tkey(N1, F1), 'thumb')).toEqual(THUMB);
    // AAD 带用途：原文件的密文当缩略图解、文件名的密文当文字解，都解不开
    expect(await openPart(dek, A, F1, 'thumb', w.r2.objs.get(`vault-files/${fkey(N1, F1)}`)!.bytes)).toBeNull();
    expect(await openText(dek, A, F1, 'text', f.name_enc!)).toBeNull();
    expect(w.r2.keys('files')).toEqual([]);
    expect(w.r2.puts.filter((p) => p.bucket === 'vault-files').map((p) => p.contentType)).toEqual(['application/octet-stream', 'application/octet-stream']);
    expect(w.db.s.vectors.has(`${A}|file|${F1}`)).toBe(false);
    expect(w.db.s.vaultAi.has(`${A}|${F1}`)).toBe(false);
  });

  it('带附件移出：解密写回 files（contentType 按 kind、缩略图 webp），名字、文字、明文 sha256 还原，ai_status pending；vault-files 删空', async () => {
    const { w, tok } = await withFile();
    await call(w, { action: 'import', note_id: N1 }, { token: tok });
    w.r2.puts.length = 0;
    expect((await call(w, { action: 'export', note_id: N1 }, { token: tok })).status).toBe(200);
    expect(w.db.s.files.get(F1)).toMatchObject({
      is_vault: false, name: '合同.pdf', text_excerpt: '抽出的文字', sha256: await sha256Hex(PDF), name_enc: null, text_enc: null, dek_enc: null, enc_key_id: null,
      ai_status: 'pending', skip_reason: null, ai_tries: 0, check_status: 'ok',
    });
    expect(w.r2.objs.get(`files/${fkey(N1, F1)}`)).toEqual({ bytes: PDF, contentType: 'application/pdf' });
    expect(w.r2.objs.get(`files/${tkey(N1, F1)}`)).toEqual({ bytes: THUMB, contentType: 'image/webp' });
    expect(w.r2.keys('vault-files')).toEqual([]);
  });

  it('还在检查（pending）的附件：移进回 503 try_later，什么都不写；已删的 pending 不挡', async () => {
    const { w, tok } = await withFile();
    w.db.s.files.get(F1)!.check_status = 'pending';
    const r = await call(w, { action: 'import', note_id: N1 }, { token: tok });
    expect([r.status, r.body.error]).toEqual([503, 'try_later']);
    expect(w.r2.puts).toEqual([]);
    expect(w.db.s.notes.get(N1)?.is_private).toBe(false);
    w.db.s.files.get(F1)!.deleted_at = 9;
    expect((await call(w, { action: 'import', note_id: N1 }, { token: tok })).status).toBe(200);
  });

  it('移出时 HMAC 和解出来的内容对不上：回 503、记 move_integrity，库和两个桶都不动', async () => {
    const { w, tok } = await withFile();
    await call(w, { action: 'import', note_id: N1 }, { token: tok });
    w.db.s.files.get(F1)!.sha256 = await shaMac(MASTER, A, 'e'.repeat(64));
    const r = await call(w, { action: 'export', note_id: N1 }, { token: tok });
    expect([r.status, r.body.error]).toEqual([503, 'try_later']);
    expect(w.logs).toContain('move_integrity');
    expect(w.db.s.notes.get(N1)?.is_private).toBe(true);
    expect(w.db.s.files.get(F1)?.is_vault).toBe(true);
    expect(w.r2.keys('files')).toEqual([]);
    expect(w.r2.keys('vault-files')).toHaveLength(2);
  });

  it('移出时数据密钥换了人（AAD 带 user_id）解不开：回 503、记 decrypt_failed', async () => {
    const { w, tok } = await withFile();
    await call(w, { action: 'import', note_id: N1 }, { token: tok });
    const f = w.db.s.files.get(F1)!;
    f.dek_enc = await wrapDek(MASTER, B, F1, (await unwrapDek(MASTER, A, F1, f.dek_enc!))!);
    const r = await call(w, { action: 'export', note_id: N1 }, { token: tok });
    expect([r.status, w.logs.includes('decrypt_failed')]).toEqual([503, true]);
    expect(w.db.s.notes.get(N1)?.is_private).toBe(true);
  });

  it('移进的提交失败：vault-files 里刚写的对象删掉，files 和行都不动', async () => {
    const { w, tok } = await withFile();
    const run = w.db.run.bind(w.db);
    let n = 0;
    w.deps.tx = (uid, fn) => (++n === 3 ? Promise.reject(new Error('commit')) : run(uid, fn));
    expect((await call(w, { action: 'import', note_id: N1 }, { token: tok })).status).toBe(503);
    expect(w.r2.keys('vault-files')).toEqual([]);
    expect(w.r2.keys('files')).toHaveLength(2);
    expect(w.db.s.files.get(F1)).toMatchObject({ is_vault: false, name: '合同.pdf' });
  });

  it('并发移进带附件：后到那次的对象盖掉了先提交那次的（不带 If-None-Match），回 404 前按已提交行的数据密钥重封', async () => {
    const { w, tok } = await withFile();
    const put = w.r2.put.bind(w.r2);
    let raced = false;
    let first: Awaited<ReturnType<typeof call>> | null = null;
    w.r2.put = async (b, k, body, o) => {
      if (b === 'vault-files' && !raced) {   // 后到那次第一次写 vault-files 之前（它已经读好明文），先提交的那次从头到尾做完
        raced = true;
        first = await call(w, { action: 'import', note_id: N1 }, { token: tok });
      }
      return put(b, k, body, o);
    };
    const second = await call(w, { action: 'import', note_id: N1 }, { token: tok });
    expect((first as unknown as { status: number }).status).toBe(200);
    expect([second.status, second.body.error]).toEqual([404, 'not_found']);
    expect(await openStored(w, fkey(N1, F1), 'file')).toEqual(PDF);
    expect(await openStored(w, tkey(N1, F1), 'thumb')).toEqual(THUMB);
  });

});
