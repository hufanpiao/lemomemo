// 生成器本身的测试（TC-B0-29、TC-B0-30 的生成部分）。用样例清单，不连数据库。
import { describe, expect, it } from 'vitest';
import { ManifestError, generate } from './generate.ts';
import { sampleCore, sampleManifests, sampleNotes } from './sample-manifests.ts';
import type { Manifest } from './types.ts';
import { allManifests } from '../../shared/manifests/index.ts';

const byId = (id: string) => generate(sampleManifests).cases.find((c) => c.id === id);

describe('注销用例（TC-DEL-*）', () => {
  it('每张表、每个桶、每个本机仓各一条，编号不重复', () => {
    const { cases } = generate(sampleManifests);
    const del = cases.filter((c) => c.kind === 'account-delete').map((c) => c.id).sort();
    expect(del).toEqual(
      [
        'TC-DEL-app_config',
        'TC-DEL-bucket-backups',
        'TC-DEL-bucket-images',
        'TC-DEL-bucket-vault-preview',
        'TC-DEL-counters',
        'TC-DEL-idb-meta',
        'TC-DEL-idb-outbox',
        'TC-DEL-idb-sync',
        'TC-DEL-notes',
        'TC-DEL-pending_signups',
        'TC-DEL-profiles',
        'TC-DEL-settings',
        'TC-DEL-tombstones',
        'TC-DEL-vault_preview',
      ].sort(),
    );
  });

  it('按列找人', () => {
    expect(byId('TC-DEL-settings')?.probe).toEqual({
      a: 'select count(*) from public.settings where user_id = :user_a',
      b: 'select count(*) from public.settings where user_id = :user_b',
    });
  });

  it('counters 按键的第二段找人（keyPattern）', () => {
    expect(byId('TC-DEL-counters')?.probe?.a).toBe(
      "select count(*) from private.counters where key like replace('%:<user>:%', '<user>', :user_a::text)",
    );
  });

  it('pending_signups 按邮箱哈希找人', () => {
    expect(byId('TC-DEL-pending_signups')?.probe?.b).toBe('select count(*) from private.pending_signups where email_hash = :email_hash_b');
  });

  it('noUserData 生成“注销前后不变”的快照', () => {
    const c = byId('TC-DEL-app_config');
    expect(c?.probe?.a).toContain('md5(');
    expect(c?.probe?.b).toBeUndefined();
    expect(c?.expect).toContain('不变');
  });

  it('backups 桶按第二级目录找人，误按第一级就对不上', () => {
    const a = byId('TC-DEL-bucket-backups')?.probe?.a ?? '';
    expect(a).toContain("split_part(name, '/', 2) = :user_a::text");
    expect(a).not.toContain("split_part(name, '/', 1)");
  });

  it('images 桶两段登记（notes、anniv 头像）合成一条，两段都算', () => {
    const c = byId('TC-DEL-bucket-images');
    expect(c?.manifests.sort()).toEqual(['anniv', 'notes']);
    expect(c?.probe?.a).toContain("name like :user_a::text || '/%'");
    expect(c?.probe?.a).toContain("name like :user_a::text || '/anniv/%'");
    expect(c?.probe?.a).toContain('name ~ ');
  });

  it('vault-preview 按登记表找人（路径不含 user_id）', () => {
    expect(byId('TC-DEL-bucket-vault-preview')?.probe?.a).toBe(
      "select count(*) from storage.objects where bucket_id = 'vault-preview' and ((name in (select path from private.vault_preview where user_id = :user_a)))",
    );
  });

  it('本机：同步表合成一条 e2e 用例', () => {
    const c = byId('TC-DEL-idb-sync');
    expect(c?.runner).toBe('e2e');
    expect(c?.target).toBe('idb:settings,notes');
  });
});

describe('系统列用例（TC-B0-29）', () => {
  it('条数 = 挂 touch() 的表数 × 2', () => {
    const { counts } = generate(sampleManifests);
    expect(counts['system-cols']).toBe(2 * 2); // settings、notes
  });

  it('只改系统列 rev 不变，改普通列 rev 加 1', () => {
    expect(byId('TC-SYS-notes-system')?.act).toBe('update public.notes set ai_meta = :new_value where id = :row_id');
    expect(byId('TC-SYS-notes-system')?.expect).toBe('rev 不变');
    expect(byId('TC-SYS-notes-plain')?.act).toBe('update public.notes set body = :new_value where id = :row_id');
    expect(byId('TC-SYS-notes-plain')?.expect).toBe('rev 加 1');
  });

  it('系统列同时在 clientWritable 里 → 报错（违规样例）', () => {
    const bad: Manifest = {
      ...sampleNotes,
      tables: [{ ...sampleNotes.tables[0]!, clientWritable: ['body', 'ai_meta'] }],
    };
    expect(() => generate([bad])).toThrow(ManifestError);
  });
});

describe('其他几类', () => {
  it('软删除的表生成 30 天清理用例', () => {
    expect(byId('TC-PURGE-notes')?.kind).toBe('soft-delete-purge');
    expect(byId('TC-PURGE-settings')).toBeDefined();
  });

  it('孤儿清理、临时桶到期', () => {
    expect(byId('TC-ORPHAN-images')?.kind).toBe('orphan-sweep');
    expect(byId('TC-TTL-vault-preview')?.kind).toBe('max-lifetime');
  });

  it('有 vaultRows 的表生成“只有密文”的用例，plainColsMustBeNull 在禁止列表里', () => {
    const c = byId('TC-VAULT-notes');
    expect(c?.cols?.forbidden).toContain('body');
    expect(c?.cols?.allowed).toContain('body_enc');
    expect(c?.cols?.allowed).not.toContain('body');
  });
});

describe('清单不合规时拒绝生成', () => {
  it('userLookup 和 noUserData 都没写 / 都写了', () => {
    const none: Manifest = { feature: 'x', owner: 'x', tables: [{ name: 'counters', schema: 'private', sync: false }] };
    const both: Manifest = {
      feature: 'x',
      owner: 'x',
      tables: [{ name: 'ai_state', schema: 'private', sync: false, noUserData: true, userLookup: { by: 'column', col: 'user_id' } }],
    };
    expect(() => generate([none])).toThrow(/二选一/);
    expect(() => generate([both])).toThrow(/二选一/);
  });

  it('同一张表登记在两份清单里', () => {
    expect(() => generate([sampleCore, { ...sampleCore, feature: 'other' }])).toThrow(/两份清单/);
  });

  it('表名、列名不是合法标识符', () => {
    const bad: Manifest = { feature: 'x', owner: 'x', tables: [{ name: 'a;drop', schema: 'public', sync: false, noUserData: true }] };
    expect(() => generate([bad])).toThrow(ManifestError);
  });

  it('keyPattern 里没有 <user>', () => {
    const bad: Manifest = {
      feature: 'x',
      owner: 'x',
      tables: [{ name: 'counters', schema: 'private', sync: false, userLookup: { by: 'keyPattern', col: 'key', pattern: '%' } }],
    };
    expect(() => generate([bad])).toThrow(/<user>/);
  });

  it('桶没有任何找人办法', () => {
    const bad: Manifest = { feature: 'x', owner: 'x', tables: [], buckets: [{ name: 'files', userLookup: { by: 'column', col: 'user_id' } }] };
    expect(() => generate([bad])).toThrow(ManifestError);
  });
});

// B0 集成：后端的真清单（shared/manifests）直接传进生成器
describe('后端的真清单', () => {
  const { cases } = generate(allManifests);

  it('每张表一条注销用例，编号不重复', () => {
    const tables = allManifests.flatMap((m) => m.tables).map((t) => `TC-DEL-${t.name}`);
    const del = new Set(cases.filter((c) => c.kind === 'account-delete').map((c) => c.id));
    for (const id of tables) expect(del.has(id), id).toBe(true);
  });

  it('remind_queue 按引用的行找人（rowRef）', () => {
    const c = cases.find((x) => x.id === 'TC-DEL-remind_queue');
    expect(c?.probe?.a).toMatch(/table_name = 'todos' and exists \(select 1 from public\.todos r where r\.id = id and r\.user_id = :user_a\)/);
  });

  it('backups 桶按第二级目录找人；孤儿清理用 after', () => {
    expect(cases.find((x) => x.id === 'TC-DEL-bucket-backups')?.probe?.a).toContain("split_part(name, '/', 2)");
    expect(cases.some((x) => x.kind === 'orphan-sweep' && x.act?.includes('早于 24 hours'))).toBe(true);
  });
});
