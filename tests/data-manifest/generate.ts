// 按数据清单生成用例（架构 3.5 第 4 点、0.27 第 2 点；测试用例 v4 的 TC-B0-29、TC-B0-30 和 3.3 节 TC-DEL-*）。
// 新功能写了清单，用例就自动有了。生成的 SQL 断言由后端审；执行这些用例的 runner 要本地 Supabase，CI 里跑。
//
// SQL 里的占位符（runner 用参数绑定替换，不拼字符串）：
//   :user_a / :user_b         两个测试账号的 user_id（A 注销，B 是对照）
//   :email_hash_a / _b        按 _shared/email-hash.ts 算出的邮箱哈希（和 invite-signup 同一个函数）
//   :row_id / :old_id / :new_id  runner 造的行
//   :new_value                runner 按列类型造的新值（和原值不同）

import { maxLifetimeCase, orphanCase, softDeleteCase, systemColCases, vaultRowsCase } from './other-cases.ts';
import { type CaseKind, type GeneratedCase, ManifestError, ident, lit, qualified, splitQualified } from './sql.ts';
import type { LocalStore, Manifest, ManifestBucket, ManifestTable, UserLookup } from './types.ts';

export { ManifestError, type CaseKind, type GeneratedCase } from './sql.ts';

const BUCKET = /^[a-z0-9][a-z0-9-]*$/;

function requireOneOf(o: { userLookup?: UserLookup | undefined; noUserData?: true | undefined }, where: string): void {
  const has = !!o.userLookup;
  const none = o.noUserData === true;
  if (has === none) throw new ManifestError(`${where}：userLookup 和 noUserData 必须二选一（3.5，0.23 N3）`);
}

// ---------- 注销：表 ----------

function tableCondition(t: ManifestTable, who: 'a' | 'b', refTables: readonly string[] = []): string {
  const lk = t.userLookup;
  if (!lk) throw new ManifestError(`${t.name}：没有 userLookup`);
  const uid = `:user_${who}`;
  switch (lk.by) {
    case 'column':
      return `${ident(lk.col, '列名')} = ${uid}`;
    case 'keyPattern': {
      if (!lk.pattern.includes('<user>')) throw new ManifestError(`${t.name}：keyPattern 里没有 <user>`);
      return `${ident(lk.col, '列名')} like replace(${lit(lk.pattern)}, '<user>', ${uid}::text)`;
    }
    case 'emailHash':
      return `${ident(lk.col, '列名')} = :email_hash_${who}`;
    case 'registry':
      return `${ident(lk.col, '列名')} = ${uid}`;
    case 'pathPattern':
      throw new ManifestError(`${t.name}：表不能用 pathPattern 找人`);
    case 'rowRef': {
      // 引用的行在哪张表由 tableCol 列决定：逐个对“按 user_id 找人”的 public 表拼 exists（例如 remind_queue → events、todos、anniversaries）
      const tc = ident(lk.tableCol, '列名');
      const ic = ident(lk.idCol, '列名');
      if (refTables.length === 0) throw new ManifestError(`${t.name}：rowRef 找不到可以引用的表`);
      return `(${refTables
        .map((r) => `(${tc} = ${lit(r)} and exists (select 1 from ${qualified('public', r)} r where r.id = ${ic} and r.user_id = ${uid}))`)
        .join(' or ')})`;
    }
  }
}

function deleteCaseForTable(t: ManifestTable, manifest: string, refTables: readonly string[] = []): GeneratedCase {
  const q = qualified(t.schema, t.name);
  if (t.noUserData) {
    // 注销前后整张表不变
    const snap = `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from ${q} x`;
    return {
      id: `TC-DEL-${t.name}`,
      kind: 'account-delete',
      runner: 'sql',
      target: q,
      manifests: [manifest],
      probe: { a: snap },
      act: 'account-delete',
      expect: 'noUserData：注销前后快照不变',
    };
  }
  const lk = t.userLookup;
  if (!lk) throw new ManifestError(`${t.name}：userLookup 和 noUserData 必须二选一（3.5，0.23 N3）`);
  const from = lk.by === 'registry' ? qualified(...splitQualified(lk.table)) : q;
  return {
    id: `TC-DEL-${t.name}`,
    kind: 'account-delete',
    runner: 'sql',
    target: q,
    manifests: [manifest],
    probe: {
      a: `select count(*) from ${from} where ${tableCondition(t, 'a', refTables)}`,
      b: `select count(*) from ${from} where ${tableCondition(t, 'b', refTables)}`,
    },
    act: 'account-delete',
    expect: `冷静期里 A 的行还在；account-purge 之后 A 的为 0、B 的条数不变（按 ${describeLookup(lk)} 找人）`,
  };
}

function describeLookup(lk: UserLookup): string {
  switch (lk.by) {
    case 'column':
      return `列 ${lk.col}`;
    case 'keyPattern':
      return `${lk.col} 匹配 ${lk.pattern}`;
    case 'emailHash':
      return `邮箱哈希 ${lk.col}`;
    case 'registry':
      return `登记表 ${lk.table}.${lk.col}`;
    case 'pathPattern':
      return `路径第 ${lk.level} 级目录`;
    case 'rowRef':
      return `${lk.tableCol}、${lk.idCol} 引用的行`;
  }
}

// ---------- 注销：桶 ----------

function bucketSegmentCondition(b: ManifestBucket, who: 'a' | 'b'): string {
  const uid = `:user_${who}::text`;
  const lk = b.userLookup;
  if (lk?.by === 'registry') {
    const [s, t] = splitQualified(lk.table);
    const pathCol = ident(lk.pathCol ?? 'path', '列名');
    return `name in (select ${pathCol} from ${qualified(s, t)} where ${ident(lk.col, '列名')} = :user_${who})`;
  }
  const conds: string[] = [];
  // 第一级就是 user_id、又写了 '<user_id>/…' 前缀的，按前缀找（更精确）；其余按第几级目录（backups：<date>/<user_id>/…，level 2）
  const byPrefix = b.pathPrefix?.startsWith('<user_id>/') && (lk?.by !== 'pathPattern' || lk.level === 1);
  if (lk?.by === 'pathPattern' && !byPrefix) {
    const seg = lk.level;
    if (!Number.isInteger(seg) || seg < 1) throw new ManifestError(`${b.name}：level 要是正整数`);
    conds.push(`split_part(name, '/', ${seg}) = ${uid}`);
    // 同一个桶分段登记时（images 桶的纪念日头像段），再按前缀里 <user_id>/ 后面那一段收窄
    const rest = b.pathPrefix?.startsWith('<user_id>/') ? b.pathPrefix.slice('<user_id>/'.length) : '';
    if (rest) conds.push(`name like ${uid} || ${lit('/' + escapeLike(rest) + '%')}`);
  } else if (b.pathPrefix) {
    // 按路径前缀找人：'<user_id>/'、'<user_id>/anniv/'
    if (!b.pathPrefix.startsWith('<user_id>/')) throw new ManifestError(`${b.name}：pathPrefix 要以 <user_id>/ 开头，或者改用 userLookup`);
    const rest = escapeLike(b.pathPrefix.slice('<user_id>/'.length));
    conds.push(`name like ${uid} || ${lit('/' + rest + '%')}`);
  } else {
    throw new ManifestError(`${b.name}：桶没有 pathPrefix，也没有 pathPattern / registry 的 userLookup`);
  }
  if (b.pathPattern) conds.push(`name ~ ${lit(b.pathPattern)}`);
  return conds.join(' and ');
}

/** like 里的 \ % _ 转义 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

function deleteCaseForBucket(name: string, segments: { b: ManifestBucket; manifest: string }[]): GeneratedCase {
  if (!BUCKET.test(name)) throw new ManifestError(`桶名不合规：${name}`);
  const userSegs = segments.filter((s) => !s.b.noUserData);
  if (userSegs.length === 0) {
    return {
      id: `TC-DEL-bucket-${name}`,
      kind: 'account-delete',
      runner: 'sql',
      target: `storage:${name}`,
      manifests: segments.map((s) => s.manifest),
      probe: { a: `select md5(coalesce(string_agg(name, '|' order by name), '')) from storage.objects where bucket_id = ${lit(name)}` },
      act: 'account-delete',
      expect: 'noUserData：注销前后桶里的对象不变',
    };
  }
  const cond = (who: 'a' | 'b') => userSegs.map((s) => `(${bucketSegmentCondition(s.b, who)})`).join(' or ');
  return {
    id: `TC-DEL-bucket-${name}`,
    kind: 'account-delete',
    runner: 'sql',
    target: `storage:${name}`,
    manifests: [...new Set(segments.map((s) => s.manifest))],
    probe: {
      a: `select count(*) from storage.objects where bucket_id = ${lit(name)} and (${cond('a')})`,
      b: `select count(*) from storage.objects where bucket_id = ${lit(name)} and (${cond('b')})`,
    },
    act: 'account-delete',
    expect: '冷静期里 A 的对象还在；account-purge 之后 A 的为 0（每一段路径都造一个），B 的不变',
  };
}

// ---------- 主函数 ----------

export interface GenerateResult {
  cases: GeneratedCase[];
  /** 注销用例的条数（TC-B0-30 拿来和测试用例 3.3 节的表比） */
  counts: Record<CaseKind, number>;
}

export function generate(manifests: readonly Manifest[]): GenerateResult {
  const cases: GeneratedCase[] = [];
  const tableOwners = new Map<string, string>();
  const buckets = new Map<string, { b: ManifestBucket; manifest: string }[]>();
  const syncTables: string[] = [];
  const localStores = new Map<string, LocalStore & { manifest: string }>();

  // rowRef 能引用的表：public 里按 user_id 列找人的表
  const refTables = manifests
    .flatMap((m) => m.tables)
    .filter((t) => t.schema === 'public' && t.userLookup?.by === 'column' && t.userLookup.col === 'user_id')
    .map((t) => t.name);

  for (const m of manifests) {
    for (const t of m.tables) {
      const key = `${t.schema}.${t.name}`;
      // 一张表的主人只有一份清单（3.5 “一条原则”）
      if (tableOwners.has(key)) throw new ManifestError(`${key} 登记在 ${tableOwners.get(key)} 和 ${m.feature} 两份清单里`);
      tableOwners.set(key, m.feature);
      requireOneOf(t, key);
      cases.push(deleteCaseForTable(t, m.feature, refTables));
      if (t.sync === true) syncTables.push(t.name);
      cases.push(...systemColCases(t, m.feature));
      if (t.softDelete) cases.push(softDeleteCase(t, m.feature));
      if (t.vaultRows) cases.push(vaultRowsCase(t, m.feature));
    }
    for (const b of m.buckets ?? []) {
      requireOneOf(b, `桶 ${b.name}${b.pathPrefix ? ` ${b.pathPrefix}` : ''}`);
      const list = buckets.get(b.name) ?? [];
      list.push({ b, manifest: m.feature });
      buckets.set(b.name, list);
      if (b.orphanSweep) cases.push(orphanCase(b, m.feature));
      if (b.maxLifetime) cases.push(maxLifetimeCase(b, m.feature));
    }
    for (const s of m.localStores ?? []) {
      if (localStores.has(s.name)) throw new ManifestError(`本机仓 ${s.name} 登记了两次`);
      localStores.set(s.name, { ...s, manifest: m.feature });
    }
  }

  for (const [name, segs] of buckets) cases.push(deleteCaseForBucket(name, segs));

  // 本机：同步表的仓合成一条，其他仓各一条（3.3 节 TC-DEL-idb-*）
  if (syncTables.length) {
    cases.push({
      id: 'TC-DEL-idb-sync',
      kind: 'account-delete',
      runner: 'e2e',
      target: `idb:${syncTables.join(',')}`,
      manifests: [...new Set(manifests.filter((m) => m.tables.some((t) => t.sync === true)).map((m) => m.feature))],
      act: 'account-delete',
      expect: `另一台登录过的设备最迟 10 分钟内清空这些仓：${syncTables.join('、')}`,
    });
  }
  for (const s of localStores.values()) {
    cases.push({
      id: `TC-DEL-idb-${s.name}`,
      kind: 'account-delete',
      runner: 'e2e',
      target: `idb:${s.name}`,
      manifests: [s.manifest],
      act: 'account-delete',
      expect: `本机仓 ${s.name} 清空`,
    });
  }

  const counts: Record<CaseKind, number> = {
    'account-delete': 0,
    'system-cols': 0,
    'soft-delete-purge': 0,
    'orphan-sweep': 0,
    'max-lifetime': 0,
    'vault-rows-cipher-only': 0,
  };
  for (const c of cases) counts[c.kind]++;
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new ManifestError(`生成的用例编号重复：${c.id}`);
    ids.add(c.id);
  }
  return { cases, counts };
}
