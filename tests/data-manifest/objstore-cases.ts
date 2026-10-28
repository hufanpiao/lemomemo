// 对象存储探针（架构 0.32、3.5 第 4 点；任务单 FB-6；TC-B0-117）：store = 'r2' 的桶不在 storage.objects 里，
// 注销、孤儿清理、临时桶用例改由 runner 经 shared/objstore.ts 列前缀、数个数（本机和 CI 打 S3 替身，预览打 R2）。
// store = 'supabase' 的桶照旧走 generate.ts 的 SQL 探针。
//
// 选择器里的占位符（runner 替换，不拼进 SQL）：
//   <user>                A 或 B 的 user_id（count 模式分别数一次）
//   :old_id / :new_id     runner 造的对象 key（head 模式）

import { type GeneratedCase, ManifestError, type ObjProbe, type ObjSelector, ident, qualified, splitQualified } from './sql.ts';
import type { ManifestBucket } from './types.ts';

const USER = '<user>';

/** 桶的一段登记 → 选择器（只支持按路径找人；R2 桶按登记表找人要连库，暂时不支持） */
export function objSelector(b: ManifestBucket): ObjSelector {
  const lk = b.userLookup;
  if (!lk || lk.by !== 'pathPattern') throw new ManifestError(`${b.name}：R2 桶只能按 pathPattern 找人（registry 要连库，对象存储探针不支持）`);
  if (!Number.isInteger(lk.level) || lk.level < 1) throw new ManifestError(`${b.name}：level 要是正整数`);
  const pattern = b.pathPattern ?? null;
  if (pattern !== null) new RegExp(pattern); // 正则写错在生成时就报
  // 第一级是 user_id、又写了 '<user_id>/…' 前缀：按前缀列（更精确，也不用列整个桶）
  if (lk.level === 1 && b.pathPrefix?.startsWith('<user_id>/')) {
    return { prefix: USER + '/' + b.pathPrefix.slice('<user_id>/'.length), level: null, pattern };
  }
  if (b.pathPrefix?.startsWith('<user_id>/')) throw new ManifestError(`${b.name}：pathPrefix 以 <user_id>/ 开头，level 却不是 1`);
  return { prefix: '', level: lk.level, pattern };
}

export function objDeleteCase(name: string, segments: { b: ManifestBucket; manifest: string }[]): GeneratedCase {
  const userSegs = segments.filter((s) => !s.b.noUserData);
  const manifests = [...new Set(segments.map((s) => s.manifest))];
  if (userSegs.length === 0) {
    return {
      id: `TC-DEL-bucket-${name}`,
      kind: 'account-delete',
      runner: 'objstore',
      target: `r2:${name}`,
      manifests,
      objProbe: { bucket: name, mode: 'snapshot' },
      act: 'account-delete',
      expect: 'noUserData：注销前后桶里的对象不变',
    };
  }
  return {
    id: `TC-DEL-bucket-${name}`,
    kind: 'account-delete',
    runner: 'objstore',
    target: `r2:${name}`,
    manifests,
    objProbe: { bucket: name, mode: 'count', selectors: userSegs.map((s) => objSelector(s.b)) },
    act: 'account-delete',
    expect: '冷静期里 A 的对象还在；account-purge 之后 A 的为 0（每一段路径都造一个；删完再列一次确认），B 的不变',
  };
}

export function objOrphanCase(b: ManifestBucket, manifest: string, suffix: string): GeneratedCase {
  const o = b.orphanSweep;
  if (!o) throw new ManifestError(`${b.name}：没有 orphanSweep，不该生成孤儿清理用例`);
  const [s, t] = splitQualified(o.table);
  return {
    id: `TC-ORPHAN-${b.name}${suffix}`,
    kind: 'orphan-sweep',
    runner: 'objstore',
    target: `r2:${b.name}`,
    manifests: [manifest],
    objProbe: { bucket: b.name, mode: 'head', keys: [':old_id', ':new_id'] },
    act: `造两个在 ${qualified(s, t)}.${ident(o.col, '列名')} 里没有记录的对象：早于 ${o.after}（:old_id）、晚于（:new_id）；跑孤儿清理`,
    expect: '早的被清掉，新的留着（上传和写记录之间的空档不误删）',
  };
}

export function objMaxLifetimeCase(b: ManifestBucket, manifest: string, suffix: string): GeneratedCase {
  return {
    id: `TC-TTL-${b.name}${suffix}`,
    kind: 'max-lifetime',
    runner: 'objstore',
    target: `r2:${b.name}`,
    manifests: [manifest],
    objProbe: { bucket: b.name, mode: 'head', keys: [':old_id'] },
    act: `造一个对象，注入时间到 ${b.maxLifetime} 之后；跑临时桶清理`,
    expect: '对象和登记都没有了',
  };
}

/** cases.sql 旁边给人看的说明（runner 读 cases.json 里的 objProbe） */
export function describeObjProbe(p: ObjProbe): string {
  if (p.mode === 'snapshot') return `整桶 ${p.bucket} 的 key 列表注销前后不变`;
  if (p.mode === 'head') return `${p.bucket} 里 ${(p.keys ?? []).join('、')} 在不在`;
  return (p.selectors ?? [])
    .map((s) => `${p.bucket}：前缀 ${s.prefix || '（整桶）'}${s.level ? `，第 ${s.level} 级目录是 <user>` : ''}${s.pattern ? `，key 匹配 ${s.pattern}` : ''}`)
    .join('；');
}
