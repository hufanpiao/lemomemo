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
    const [notes] = sampleNotes.tables;
    if (!notes) throw new Error('样例清单没有表');
    const bad: Manifest = {
      ...sampleNotes,
      tables: [{ ...notes, clientWritable: ['body', 'ai_meta'] }],
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

  it('remind_queue 按引用的行找人（rowRef）：外层列写全名，只引用同步表', () => {
    const c = cases.find((x) => x.id === 'TC-DEL-remind_queue');
    expect(c?.probe?.a).toContain(
      "(table_name = 'todos' and exists (select 1 from public.todos r where r.id = private.remind_queue.id and r.user_id = :user_a))",
    );
    // 裸的 id 在子查询里会解析成 r.id，条件恒真
    expect(c?.probe?.a).not.toMatch(/r\.id = id\b/);
    // profiles 没有 id 列（主键是 user_id），拼进去整条 SQL 报错
    expect(c?.probe?.a).not.toContain('public.profiles');
    for (const t of ['events', 'todos', 'anniversaries']) expect(c?.probe?.a).toContain(`public.${t} r`);
    // A 那一侧连孤儿一起数；B 那一侧只数 B 的
    expect(c?.probe?.a).toContain(' or not (');
    expect(c?.probe?.b).not.toContain(' or not (');
  });

  it('backups 桶按第二级目录找人；孤儿清理用 after', () => {
    expect(cases.find((x) => x.id === 'TC-DEL-bucket-backups')?.probe?.a).toContain("split_part(name, '/', 2)");
    expect(cases.some((x) => x.kind === 'orphan-sweep' && x.act?.includes('早于 24 hours'))).toBe(true);
  });
});

// 0.31 第 17 条（P-29）：rowRef 生成的 SQL 在真的 Postgres（PGlite）上跑，看数得对不对
describe('rowRef 的探针在数据库上数得对（PGlite）', () => {
  const A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const B = 'bbbbbbbb-0000-4000-8000-000000000002';
  const bind = (sql: string) => sql.replace(/:user_([ab])\b/g, (_m, w: string) => `'${w === 'a' ? A : B}'::uuid`);
  const refsOf = (sql: string) => [...sql.matchAll(/from public\.([a-z_]+) r /g)].map((m) => m[1]);

  it('A 的队列行能数到；漏删（被引用的行删了、队列行还在）也数得到；删干净后为 0，B 不受影响', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    try {
      const c = generate(allManifests).cases.find((x) => x.id === 'TC-DEL-remind_queue');
      const a = c?.probe?.a ?? '';
      const b = c?.probe?.b ?? '';
      await db.exec(
        `create schema private;
         create table private.remind_queue (table_name text, id uuid, primary key (table_name, id));
         ${[...new Set(refsOf(a))].map((r) => `create table public.${r} (id uuid primary key, user_id uuid not null);`).join('\n')}
         insert into public.todos values ('10000000-0000-4000-8000-000000000001', '${A}'), ('10000000-0000-4000-8000-000000000002', '${B}');
         insert into public.events values ('20000000-0000-4000-8000-000000000001', '${A}');
         insert into public.anniversaries values ('30000000-0000-4000-8000-000000000001', '${B}');
         insert into private.remind_queue values
           ('todos', '10000000-0000-4000-8000-000000000001'), ('events', '20000000-0000-4000-8000-000000000001'),
           ('todos', '10000000-0000-4000-8000-000000000002'), ('anniversaries', '30000000-0000-4000-8000-000000000001');`,
      );
      const count = async (sql: string) => Number((await db.query<{ count: number }>(bind(sql))).rows[0]?.count);
      expect(await count(a)).toBe(2);
      expect(await count(b)).toBe(2);

      // 漏删：A 的待办、日程删了，队列行还在 → 仍然数到 2（只按主人数的话这里是 0，测不出漏删）
      await db.exec(`delete from public.todos where user_id = '${A}'; delete from public.events where user_id = '${A}';`);
      expect(await count(a)).toBe(2);
      expect(await count(b)).toBe(2);

      // 按 0.31 第 17 条删掉 A 的队列行：A 为 0，B 不变
      await db.exec(
        `delete from private.remind_queue where id in ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001');`,
      );
      expect(await count(a)).toBe(0);
      expect(await count(b)).toBe(2);
    } finally {
      await db.close();
    }
  });

  it('清单写了 tables 就只引用这几张；写了不认识的表、空表名单就拒绝', () => {
    const withTables = (tables: string[]): Manifest[] =>
      allManifests.map((m) => ({
        ...m,
        tables: m.tables.map((t) => (t.userLookup?.by === 'rowRef' ? { ...t, userLookup: { ...t.userLookup, tables } } : t)),
      }));
    const a = generate(withTables(['events', 'todos', 'anniversaries'])).cases.find((x) => x.id === 'TC-DEL-remind_queue')?.probe?.a ?? '';
    expect(refsOf(a)).toEqual(['events', 'todos', 'anniversaries', 'events', 'todos', 'anniversaries']);
    expect(() => generate(withTables(['profiles']))).toThrow(ManifestError);
    expect(() => generate(withTables([]))).toThrow(ManifestError);
  });
});
