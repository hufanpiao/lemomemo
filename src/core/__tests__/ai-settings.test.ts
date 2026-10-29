// settings 的两个 AI 开关（架构 0.41 第 1、2 条，0.29 续第 146 条；接手清单 CONSENT-wire ③⑦）：
// • write.* 守门：ai.enabled、ai.vault 不准软删（deleted_at 非空）、不准撤销（undone = true），码和服务器 settings_guard 一样；
//   ai.vault 只能写 false；恢复（deleted_at → null、undone → false）放行；别的键照常能删
// • writeAiSwitch：本机没有这一行就 insert，有就只 patch value；被删、被撤销过的顺带恢复；值一样不写
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAiSwitch } from '../ai-settings.ts';
import { coldStart, getBoot, resetBootForTest, type BootOptions } from '../boot.ts';
import { OutboxRejectError } from '../outbox.ts';
import { clearAllCollections, collection } from '../store.ts';
import { write } from '../write.ts';
import { fakeIndexedDB } from './idb-fake.ts';

function opts(factory: IDBFactory): BootOptions {
  return {
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: { factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  };
}

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type SRow = { id: string; key?: string; value?: unknown; deleted_at?: unknown; undone?: unknown };
const settings = () => collection<SRow>('settings');

async function boot() {
  const { factory } = fakeIndexedDB();
  return coldStart(opts(factory));
}

/** 抛的是 OutboxRejectError，码是 code */
async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  const e: unknown = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(OutboxRejectError);
  expect((e as OutboxRejectError).code).toBe(code);
}

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('write.* 守门：ai.enabled、ai.vault 不准软删、撤销（0.41 第 2 条）', () => {
  it('ai.enabled：写 deleted_at 抛 settings_key_immutable，写 undone=true 同样；不入队', async () => {
    const b = await boot();
    await write.insert('settings', { id: ID(1), key: 'ai.enabled', value: false });
    const before = (await b.outbox?.list())?.length;
    await rejectsWith(write.patch('settings', ID(1), { deleted_at: 1730000000000 }), 'settings_key_immutable');
    await rejectsWith(write.patch('settings', ID(1), { undone: true }), 'settings_key_immutable');
    expect((await b.outbox?.list())?.length).toBe(before);
    expect(settings().get(ID(1))?.deleted_at ?? null).toBeNull();
  });

  it('ai.vault：软删、撤销都抛 vault_required；patch 或 insert 成 true 也抛', async () => {
    await boot();
    await write.insert('settings', { id: ID(2), key: 'ai.vault', value: false });
    await rejectsWith(write.patch('settings', ID(2), { deleted_at: 1 }), 'vault_required');
    await rejectsWith(write.patch('settings', ID(2), { undone: true }), 'vault_required');
    await rejectsWith(write.patch('settings', ID(2), { value: true }), 'vault_required');
    await rejectsWith(write.insert('settings', { id: ID(3), key: 'ai.vault', value: true }), 'vault_required');
  });

  it('关掉（value=false）、恢复（deleted_at → null、undone → false）放行', async () => {
    await boot();
    await write.insert('settings', { id: ID(4), key: 'ai.enabled', value: true });
    expect((await write.patch('settings', ID(4), { value: false })).ok).toBe(true);
    expect((await write.patch('settings', ID(4), { deleted_at: null, undone: false })).ok).toBe(true);
  });

  it('别的 settings 键照常能删（守门只认这两个键）', async () => {
    await boot();
    await write.insert('settings', { id: ID(5), key: 'ui.skin', value: 'glass' });
    expect((await write.patch('settings', ID(5), { deleted_at: 1730000000000 })).ok).toBe(true);
  });
});

describe('writeAiSwitch：只写 value（CONSENT-wire ③⑦）', () => {
  it('本机没有 ai.enabled：insert 一行 {id, key, value: true}', async () => {
    const b = await boot();
    const r = await writeAiSwitch({ key: 'ai.enabled', value: true }, () => ID(10));
    expect(r.ok && r.item).toMatchObject({ op: 'insert', table: 'settings', data: { id: ID(10), key: 'ai.enabled', value: true } });
    expect(settings().get(ID(10))?.value).toBe(true);
    expect((await b.outbox?.list())?.length).toBe(1);
  });

  it('已有那一行：只 patch value，不带 deleted_at、undone', async () => {
    const b = await boot();
    await write.insert('settings', { id: ID(11), key: 'ai.enabled', value: false });
    await b.outbox?.list();
    const r = await writeAiSwitch({ key: 'ai.enabled', value: true });
    expect(r.ok).toBe(true);
    expect(settings().get(ID(11))?.value).toBe(true);
    const items = (await b.outbox?.list()) ?? [];
    for (const it of items) {
      expect(Object.hasOwn(it.data, 'deleted_at') && it.data['deleted_at'] !== null).toBe(false);
      expect(it.data['undone']).not.toBe(true);
    }
  });

  it('值已经一样、没被删：不写', async () => {
    const b = await boot();
    await write.insert('settings', { id: ID(12), key: 'ai.enabled', value: true });
    const n = (await b.outbox?.list())?.length;
    expect(await writeAiSwitch({ key: 'ai.enabled', value: true })).toEqual({ ok: true, item: null });
    expect((await b.outbox?.list())?.length).toBe(n);
  });

  it('那一行被软删、撤销过（服务器以前留下的）：patch value 并恢复（deleted_at → null、undone → false）', async () => {
    await boot();
    await write.insert('settings', { id: ID(13), key: 'ai.enabled', value: true });
    settings().upsert([{ ...settings().get(ID(13)), id: ID(13), deleted_at: 1730000000000, undone: true }]);
    const r = await writeAiSwitch({ key: 'ai.enabled', value: true });
    expect(r.ok).toBe(true);
    const row = settings().get(ID(13));
    expect(row?.deleted_at ?? null).toBeNull();
    expect(row?.undone ?? false).toBe(false);
  });

  it('ai.vault 关掉：写 false（类型上写不出 true）', async () => {
    await boot();
    expect((await writeAiSwitch({ key: 'ai.vault', value: false }, () => ID(14))).ok).toBe(true);
    expect(settings().get(ID(14))?.value).toBe(false);
  });

  it('本机库不可用：返回 local_unavailable，不抛错', async () => {
    expect(await writeAiSwitch({ key: 'ai.enabled', value: true })).toEqual({ ok: false, reason: 'local_unavailable' });
  });
});
