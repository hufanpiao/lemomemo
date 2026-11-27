// 数据清单生成的“注销”以外几类用例：系统列、30 天清理、孤儿清理、临时桶、隐私记行（从 generate.ts 拆出，W1）

import { type GeneratedCase, ManifestError, ident, lit, qualified, splitQualified } from './sql.ts';
import type { ManifestBucket, ManifestTable } from './types.ts';

/** TC-B0-29：挂 touch() 的表各两条——只改系统列 rev 不变；改普通列 rev 加 1 */
export function systemColCases(t: ManifestTable, manifest: string): GeneratedCase[] {
  if (t.sync !== true) return [];
  const q = qualified(t.schema, t.name);
  const sys = t.systemCols ?? [];
  const writable = (t.clientWritable ?? []).filter((c) => !sys.includes(c));
  const plain = writable[0];
  if (!plain) throw new ManifestError(`${q}：同步表没有可写的普通列，生成不了系统列用例`);
  for (const c of sys) {
    if ((t.clientWritable ?? []).includes(c)) throw new ManifestError(`${q}：${c} 同时在 systemCols 和 clientWritable 里（0.27 第 2 点）`);
  }
  const rev = `select rev from ${q} where id = :row_id`;
  const out: GeneratedCase[] = [];
  const sysCol = sys[0];
  out.push({
    id: `TC-SYS-${t.name}-system`,
    kind: 'system-cols',
    runner: 'sql',
    target: q,
    manifests: [manifest],
    probe: { a: rev },
    act: sysCol
      ? `update ${q} set ${ident(sysCol, '列名')} = :new_value where id = :row_id`
      : `-- ${q} 没有登记系统列：只改 updated_at（no_conflict）\nupdate ${q} set updated_at = :new_value where id = :row_id`,
    expect: 'rev 不变',
  });
  out.push({
    id: `TC-SYS-${t.name}-plain`,
    kind: 'system-cols',
    runner: 'sql',
    target: q,
    manifests: [manifest],
    probe: { a: rev },
    act: `update ${q} set ${ident(plain, '列名')} = :new_value where id = :row_id`,
    expect: 'rev 加 1',
  });
  return out;
}

/** 30 天清理（3.4）：31 天前删的清掉，29 天前删的留着 */
export function softDeleteCase(t: ManifestTable, manifest: string): GeneratedCase {
  const q = qualified(t.schema, t.name);
  return {
    id: `TC-PURGE-${t.name}`,
    kind: 'soft-delete-purge',
    runner: 'sql',
    target: q,
    manifests: [manifest],
    probe: {
      a: `select count(*) from ${q} where id = :old_id`,
      b: `select count(*) from ${q} where id = :new_id`,
    },
    act: '造两行：deleted_at = 注入的现在 - 31 天（:old_id）、- 29 天（:new_id）；跑每日清理',
    expect: ':old_id 的为 0，:new_id 的为 1',
  };
}

/** 同一个桶分段登记时（images 桶的纪念日头像段）用路径段区分编号：'<user_id>/anniv/' → '-anniv' */
export function segmentSuffix(b: ManifestBucket): string {
  const seg = (b.pathPrefix ?? '').replace('<user_id>/', '').replace(/\/+$/, '').replace(/\//g, '-');
  return seg ? `-${seg}` : '';
}

export function orphanCase(b: ManifestBucket, manifest: string): GeneratedCase {
  const o = b.orphanSweep;
  if (!o) throw new ManifestError(`${b.name}：没有 orphanSweep，不该生成孤儿清理用例`);
  const [s, t] = splitQualified(o.table);
  return {
    id: `TC-ORPHAN-${b.name}${segmentSuffix(b)}`,
    kind: 'orphan-sweep',
    runner: 'sql',
    target: `storage:${b.name}`,
    manifests: [manifest],
    probe: {
      a: `select count(*) from storage.objects where bucket_id = ${lit(b.name)} and name = :old_id`,
      b: `select count(*) from storage.objects where bucket_id = ${lit(b.name)} and name = :new_id`,
    },
    act: `造两个在 ${qualified(s, t)}.${ident(o.col, '列名')} 里没有记录的对象：早于 ${o.after}（:old_id）、晚于（:new_id）；跑孤儿清理`,
    expect: '早的被清掉，新的留着（上传和写记录之间的空档不误删）',
  };
}

export function maxLifetimeCase(b: ManifestBucket, manifest: string): GeneratedCase {
  return {
    id: `TC-TTL-${b.name}${segmentSuffix(b)}`,
    kind: 'max-lifetime',
    runner: 'sql',
    target: `storage:${b.name}`,
    manifests: [manifest],
    probe: { a: `select count(*) from storage.objects where bucket_id = ${lit(b.name)} and name = :old_id` },
    act: `造一个对象，注入时间到 ${b.maxLifetime} 之后；跑临时桶清理`,
    expect: '对象和登记都没有了',
  };
}

/** 0.23 N3：有 vaultRows 的表另生成一条“隐私记行同步到本机只有密文” */
export function vaultRowsCase(t: ManifestTable, manifest: string): GeneratedCase {
  const v = t.vaultRows;
  if (!v) throw new ManifestError(`${t.name}：没有 vaultRows，不该生成隐私记行用例`);
  const allowed = [...v.cipherCols, ...(v.neutralCols ?? [])];
  const overlap = v.plainColsMustBeNull.filter((c) => allowed.includes(c));
  if (overlap.length) throw new ManifestError(`${t.name}：${overlap.join('、')} 既在 plainColsMustBeNull 又在 cipherCols / neutralCols 里`);
  return {
    id: `TC-VAULT-${t.name}`,
    kind: 'vault-rows-cipher-only',
    runner: 'e2e',
    target: `${t.schema}.${t.name}`,
    manifests: [manifest],
    act: `造一条 ${v.flag} 的隐私记行，同步到本机`,
    expect: '本机缓存里这一行只有 cipherCols 和 neutralCols，plainColsMustBeNull 一列都不出现',
    cols: { allowed, forbidden: [...v.plainColsMustBeNull] },
  };
}
