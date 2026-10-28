// TC-B0-89：“表 × 角色 × 操作”正反用例生成器（grant-matrix.ts）和 runner（grant-runner.ts）。
// 生成部分纯函数；执行部分在 PGlite 上跑 7 个迁移后的真授权（离线，和 npm run test:db:offline 同一套桩）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import * as realWhitelist from '../../build/d1/whitelist.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { describeGrantCase, generateGrantMatrix, type GrantCase, type GrantWhitelist } from './grant-matrix.ts';
import { grantProblems, runGrantMatrix, type GrantDb } from './grant-runner.ts';
import { ManifestError } from './sql.ts';
import type { Manifest } from './types.ts';

const WL: GrantWhitelist = realWhitelist;
const m = generateGrantMatrix(allManifests, WL);
const cell = (relation: string, role: string, op: string): GrantCase | undefined =>
  m.cases.find((c) => c.relation === relation && c.role === role && c.op === op);

/** 白名单的可改副本（反例用） */
function wl(edit: (w: { TABLE_GRANTS: Record<string, Record<string, string[]>>; COLUMN_GRANTS: Record<string, Record<string, string[]>>; PUBLIC_RPCS: string[] }) => void): GrantWhitelist {
  const w = JSON.parse(JSON.stringify(WL)) as Parameters<typeof edit>[0];
  edit(w);
  return w as unknown as GrantWhitelist;
}

describe('生成：每张表 × 五个角色 × 四种操作都有一条', () => {
  it('格数 = 关系数 × 20，编号不重复；清单的表一张不少，四个 scan_ 视图来自白名单', () => {
    const tables = allManifests.flatMap((x) => x.tables.map((t) => `${t.schema}.${t.name}`)).sort();
    expect(m.relations.filter((r) => r.kind === 'table').map((r) => r.name)).toEqual(tables);
    expect(m.relations.filter((r) => r.kind === 'view').map((r) => r.name)).toEqual([
      'private.scan_embed_queue',
      'private.scan_note_files',
      'private.scan_note_images',
      'private.scan_vault_preview',
    ]);
    expect(m.cases).toHaveLength(m.relations.length * 20);
    expect(new Set(m.cases.map((c) => c.id)).size).toBe(m.cases.length);
  });

  it('TC-B0-89 点名的反例都在，期望写对', () => {
    expect(cell('private.vault', 'fn_ai', 'SELECT')?.expect).toEqual(['user_id', 'pin_epoch']);
    expect(cell('public.devices', 'fn_vault', 'SELECT')?.expect).toEqual(['id', 'user_id', 'deleted_at', 'session_id']);
    for (const role of ['fn_vault', 'fn_ai']) for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) expect(cell('public.anniversaries', role, op)?.expect, `${role} ${op}`).toBe('none');
    expect(cell('private.note_vectors', 'fn_vault', 'INSERT')?.expect).toBe('none');
    expect(cell('private.vault_ai', 'fn_ai', 'DELETE')?.expect).toBe('none');
    for (const t of ['notes', 'note_images', 'note_files']) expect(cell(`public.${t}`, 'fn_vault', 'DELETE')?.expect, t).toBe('none');
    // authenticated 对 devices 以外的表 delete 一律没有（续第 121 条①）
    const del = m.cases.filter((c) => c.role === 'authenticated' && c.op === 'DELETE' && c.expect === 'all').map((c) => c.relation);
    expect(del).toEqual(['public.devices']);
    // anon 调九个 public RPC 都被拒；和 3.3 D 白名单双向比（九个）
    expect(m.rpcCases.filter((c) => c.role === 'anon').map((c) => [c.fn, c.expect])).toEqual(WL.PUBLIC_RPCS.map((f) => [f, false]));
    expect(WL.PUBLIC_RPCS).toHaveLength(9);
  });

  it('正例也有：anon 只读 app_config 那几列；authenticated 按清单写；service_role 在 public 全给', () => {
    const anon = m.cases.filter((c) => c.role === 'anon' && c.expect !== 'none');
    expect(anon.map((c) => `${c.relation}:${c.op}`)).toEqual(['public.app_config:SELECT']);
    expect(cell('public.app_config', 'anon', 'SELECT')?.expect).toEqual(['id', 'min_client_version', 'latest_version', 'notice']);
    expect(cell('public.events', 'authenticated', 'SELECT')?.expect).toBe('all');
    expect(Array.isArray(cell('public.events', 'authenticated', 'INSERT')?.expect)).toBe(true);
    for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) expect(cell('public.notes', 'service_role', op)?.expect).toBe('all');
    expect(cell('private.vault', 'service_role', 'SELECT')?.expect).toBe('none');
    expect(cell('private.invites', 'service_role', 'UPDATE')?.expect).toBe('all');
    // private 对 anon、authenticated 一律 none
    expect(m.cases.filter((c) => c.relation.startsWith('private.') && (c.role === 'anon' || c.role === 'authenticated')).every((c) => c.expect === 'none')).toBe(true);
    expect(describeGrantCase(cell('private.vault', 'fn_ai', 'SELECT') as GrantCase)).toContain('只有 user_id、pin_epoch');
  });

  it('白名单和清单双向：白名单写了清单没有的表、同一格表级列级都写、空列名单、列级写 DELETE，生成时就报错', () => {
    expect(() => generateGrantMatrix(allManifests, wl((w) => { (w.TABLE_GRANTS.fn_ai ??= {})['private.nope'] = ['SELECT']; }))).toThrow(ManifestError);
    expect(() => generateGrantMatrix(allManifests, wl((w) => { (w.COLUMN_GRANTS.fn_vault ??= {})['public.nope:SELECT'] = ['id']; }))).toThrow(/清单里没有/);
    expect(() => generateGrantMatrix(allManifests, wl((w) => { (w.TABLE_GRANTS.fn_ai ??= {})['private.vault'] = ['SELECT']; }))).toThrow(/表级、列级都写了/);
    expect(() => generateGrantMatrix(allManifests, wl((w) => { (w.COLUMN_GRANTS.fn_ai ??= {})['public.events:SELECT'] = []; }))).toThrow(/空名单/);
    expect(() => generateGrantMatrix(allManifests, wl((w) => { (w.COLUMN_GRANTS.fn_ai ??= {})['public.events:DELETE'] = ['id']; }))).toThrow(/列级只能/);
    expect(() => generateGrantMatrix(allManifests, wl((w) => { w.PUBLIC_RPCS.push('apply_patch'); }))).toThrow(/重复/);
    const twice: Manifest[] = [...allManifests, { feature: 'dup', owner: 'x', tables: [allManifests[0]?.tables[0] as Manifest['tables'][number]] }];
    expect(() => generateGrantMatrix(twice, WL)).toThrow(/登记了两次/);
  });
});

describe('执行：PGlite 上 7 个迁移之后的真授权（离线）', () => {
  // 每条用例一个新实例：PGlite 每抛一次错会漏一点栈（grant-runner.ts 的注释），反例会故意多抛错
  let pg: PGlite;
  let db: GrantDb;
  beforeEach(async () => {
    const { migratedPglite } = await import('./pglite-migrated.ts');
    pg = await migratedPglite();
    db = { exec: (s) => pg.exec(s), query: (s, p) => pg.query(s, p) };
  }, 120_000);
  afterEach(async () => {
    await pg?.close();
  });

  it('全部格和九个 RPC 都和期望一致；数据库里没有生成器没覆盖的表和视图', async () => {
    const r = await runGrantMatrix(db, m);
    expect(grantProblems(r)).toEqual([]);
    expect(r.outcomes).toHaveLength(m.cases.length);
    // 九个里 B0 迁移建了 3 个，其余随 B1～B3 建，没建的不算少（架构 0.33 第 3 条）
    expect([...new Set(r.rpc.filter((x) => !x.missing).map((x) => x.id.split('-')[3]))].sort()).toEqual(['files_authorize', 'purge_deleted', 'record_consent']);
    // 正例真的执行成功了（不是什么都 42501）
    expect(r.outcomes.find((o) => o.id === 'TC-GRANT-private.vault-fn_ai-SELECT')?.actual).toEqual(['user_id', 'pin_epoch']);
    expect(r.outcomes.find((o) => o.id === 'TC-GRANT-public.devices-authenticated-DELETE')?.actual).toEqual(['*']);
  }, 120_000);

  it('改坏数据库一处（多给 fn_ai 一列、收回 fn_vault 一项、给 authenticated 删 events、给 anon 执行 RPC、多一张表），都报出来', async () => {
    await pg.exec(`grant select (pin_hash) on private.vault to fn_ai;`);
    await pg.exec(`revoke insert on private.vault_credentials from fn_vault;`);
    await pg.exec(`grant delete on public.events to authenticated;`);
    await pg.exec(`grant execute on function public.record_consent(text, boolean) to anon;`);
    await pg.exec(`create table private.qa_extra (id int);`);
    const ps = grantProblems(await runGrantMatrix(db, m));
    expect(ps.find((p) => p.startsWith('TC-GRANT-private.vault-fn_ai-SELECT'))).toBe('TC-GRANT-private.vault-fn_ai-SELECT：多给了：pin_hash');
    expect(ps.find((p) => p.startsWith('TC-GRANT-private.vault_credentials-fn_vault-INSERT'))).toContain('应有表级 INSERT，实际没有');
    expect(ps.find((p) => p.startsWith('TC-GRANT-public.events-authenticated-DELETE'))).toContain('不该有表级 DELETE');
    expect(ps.some((p) => p.startsWith('TC-GRANT-rpc-record_consent-anon'))).toBe(true);
    expect(ps).toContain('数据库里有 private.qa_extra，清单和白名单都没有（生成器没覆盖）');
    // 只报改坏的这几处，别的格不受影响
    expect(ps).toHaveLength(5);
  }, 120_000);

  it('改坏白名单一处（期望 fn_ai 能读 vault 的全部列），runner 报“少给了”', async () => {
    const loose = generateGrantMatrix(allManifests, wl((w) => {
      delete w.COLUMN_GRANTS.fn_ai?.['private.vault:SELECT'];
      (w.TABLE_GRANTS.fn_ai ??= {})['private.vault'] = ['SELECT'];
    }));
    const one = { ...loose, cases: loose.cases.filter((c) => c.relation === 'private.vault'), rpcCases: [] };
    const ps = grantProblems(await runGrantMatrix(db, one));
    expect(ps.some((p) => p.startsWith('TC-GRANT-private.vault-fn_ai-SELECT') && p.includes('应有表级') && p.includes('少给了'))).toBe(true);
  }, 120_000);
});
