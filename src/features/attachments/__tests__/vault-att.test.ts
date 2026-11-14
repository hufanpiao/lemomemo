// 隐私记附件的那一份动作（data/vault-att.ts）：上传、失败码、重传、删除撤销、取字节缓存、微软预览的结束、卸下
import { describe, expect, it, vi } from 'vitest';
import type { VaultFileItem } from '../../../../shared/schema/vault-file.ts';
import { createVaultAtt, failKeyOf, type VaultFileApi } from '../data/vault-att.ts';
import type { Prepared } from '../data/file-prep.ts';

const NOTE = '0190a000-0000-7000-8000-000000000001';
const item = (id: string, o: Partial<VaultFileItem> = {}): VaultFileItem => ({ id, note_id: NOTE, kind: 'pdf', name: `${id}.pdf`, bytes: 10, pages: 3, has_thumb: false, created_at: 1, ...o });
const prepared: Prepared = { ok: true, kind: 'pdf', mime: 'application/pdf', name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]), sha256: 'a'.repeat(64) };

function setup(over: Partial<VaultFileApi> = {}) {
  const api: VaultFileApi = {
    list: vi.fn(async () => ({ ok: true as const, files: [item('0190a000-0000-7000-8000-00000000000a')] })),
    upload: vi.fn(async (m) => ({ ok: true as const, file: item(m.id, { name: m.name }) })),
    get: vi.fn(async () => ({ ok: true as const, blob: new Blob([new Uint8Array([9, 9])]) })),
    remove: vi.fn(async () => ({ ok: true as const })),
    restore: vi.fn(async () => ({ ok: true as const })),
    msPreview: vi.fn(async () => ({ ok: true as const, url: '/sb/storage/v1/object/sign/vault-preview/ab.pptx?token=t' })),
    msPreviewEnd: vi.fn(),
    ...over,
  };
  let t = 1_700_000_000_000;
  const va = createVaultAtt(api, NOTE, { prepare: async () => prepared, now: () => (t += 1), origin: () => 'https://app.example' });
  return { api, va };
}
const file = new File([new Uint8Array([1, 2, 3])], 'a.pdf', { type: 'application/pdf' });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createVaultAtt', () => {
  it('list 后出列表；加一个：带上页数、文字、缩略图传上去，成功后进列表、不留待传', async () => {
    const { api, va } = setup();
    await va.load();
    expect(va.get().files.map((f) => f.pages)).toEqual([3]);
    const thumb = new Blob(['w'], { type: 'image/webp' });
    const r = await va.source.add(NOTE, file, async () => ({ pages: 4, text: '你好', thumb }));
    expect(r.ok).toBe(true);
    await flush();
    const call = vi.mocked(api.upload).mock.calls[0];
    expect(call?.[0]).toMatchObject({ note_id: NOTE, kind: 'pdf', name: 'a.pdf', bytes: 3, pages: 4, text: '你好' });
    expect(call?.[2]).toBe(thumb);
    expect(va.get().pending).toEqual([]);
    expect(va.get().files).toHaveLength(2);
  });

  it('被拒：待传项标失败、发提示（带原因）；网络类失败能重传，重传成功进列表', async () => {
    let n = 0;
    const { va } = setup({
      upload: vi.fn(async (m) => (++n === 1 ? { ok: false as const, code: 'try_later' } : { ok: true as const, file: item(m.id) })),
    });
    const seen: string[] = [];
    va.source.onNotice((x) => seen.push(x.key));
    await va.load();
    const r = await va.source.add(NOTE, file);
    await flush();
    expect(va.get().pending[0]?.fail).toBe('retry');
    expect(seen).toEqual(['retry']);
    expect(r.ok && va.source.retry(r.id)).toBe(true);
    await flush();
    expect(va.get().pending).toEqual([]);
  });

  it('rejected 带 reason：不能重传；409 exists 当传上了、重新 list', async () => {
    const { va } = setup({ upload: vi.fn(async () => ({ ok: false as const, code: 'rejected', reason: 'bad_archive' as const })) });
    const r = await va.source.add(NOTE, file);
    await flush();
    expect(va.get().pending[0]?.fail).toBe('bad_archive');
    expect(r.ok && va.source.retry(r.id)).toBe(false);
    const b = setup({ upload: vi.fn(async () => ({ ok: false as const, code: 'exists' })) });
    await b.va.source.add(NOTE, file);
    await flush();
    expect(b.api.list).toHaveBeenCalledTimes(1);
    expect(b.va.get().pending).toEqual([]);
  });

  it('删除软删、撤销放回原位', async () => {
    const { api, va } = setup();
    await va.load();
    const id = va.get().files[0]?.id ?? '';
    expect(await va.source.remove(id)).toBe('soft');
    expect(va.get().files).toEqual([]);
    expect(await va.source.undoRemove(id)).toBe(true);
    expect(api.restore).toHaveBeenCalledWith(id);
    expect(va.get().files.map((f) => f.id)).toEqual([id]);
  });

  it('取字节放本附件区内存（第二次不再取）；卸下就丢、结束微软预览', async () => {
    const { api, va } = setup();
    await va.load();
    const f = va.get().files[0];
    if (!f) throw new Error('no file');
    expect((await va.source.open(f)).ok).toBe(true);
    expect(va.source.inMemory(f.id)).toBe(true);
    await va.source.open(f);
    expect(api.get).toHaveBeenCalledTimes(1);
    const url = await va.source.msUrl({ ...f, kind: 'pptx' });
    expect(url).toBe(`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent('https://app.example/sb/storage/v1/object/sign/vault-preview/ab.pptx?token=t')}`);
    va.dispose();
    expect(api.msPreviewEnd).toHaveBeenCalledTimes(1);
    expect(va.source.inMemory(f.id)).toBe(false);
    va.source.msEnd();
    expect(api.msPreviewEnd).toHaveBeenCalledTimes(1);
  });

  it('不是 pptx 不要微软预览；取不到字节按码回原因', async () => {
    const { api, va } = setup({ get: vi.fn(async () => ({ ok: false as const, code: 'offline' })) });
    await va.load();
    const f = va.get().files[0];
    if (!f) throw new Error('no file');
    expect(await va.source.msUrl(f)).toBeNull();
    expect(api.msPreview).not.toHaveBeenCalled();
    expect(await va.source.open(f)).toEqual({ ok: false, why: 'offline' });
  });
});

describe('failKeyOf', () => {
  it('码 → 提示键；锁着、半路上锁不提示', () => {
    expect(['too_large', 'quota_exceeded', 'rate_limited', 'upgrade_required', 'vault_locked', 'bad_request'].map((code) => failKeyOf({ ok: false, code }))).toEqual(['too_big', 'quota', 'retry', 'upgrade', null, 'write']);
    expect(failKeyOf({ ok: false, code: 'rejected', reason: 'encrypted' })).toBe('encrypted');
  });
});
