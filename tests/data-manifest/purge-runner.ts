// 注销用例的 runner（对象存储那一半；架构 3.5 第 4 点、0.32；TC-B0-117）：接生成器产出的 runner = 'objstore'、kind = 'account-delete' 用例
// 流程：造数据（tests/fakes/objstore-seed.ts，A、B 在四个 R2 桶每一段路径都有对象）→ 探针 → account-delete（A 申请注销，进冷静期）
//       → 探针（冷静期里什么都不能少）→ account-purge（冷静期满，永久清除）→ 探针（删完再列一次：A 为 0，B 不变）
// 探针一律用前端 B 的 runObjProbe（objstore-probe.ts），存储一律按 shared/objstore.ts 的 ObjStore 接口传进来：
//   离线：tests/fakes/objstore-memory.ts 的内存替身 + memoryPurgeActs（按清单删 R2 前缀的替身，只代表 account-purge 对对象存储该做的事）
//   真替身：本地 Supabase + LocalStack（node build/objstore.mjs up）+ 真的 account-delete / account-purge 函数（B1）——【待 Docker】
// runner = 'sql' 的注销用例（store = 'supabase' 的桶、表）不归这里，由 SQL runner 打本地库（待 Docker）

import type { ObjStore } from '../../shared/objstore.ts';
import { putSeedObjects, SEED_USERS, type SeedObject, seedObjects } from '../fakes/objstore-seed.ts';
import { type ProbeResult, matches, runObjProbe } from './objstore-probe.ts';
import type { GeneratedCase } from './sql.ts';
import type { Manifest } from './types.ts';

/** 注销的两步动作：离线是替身，真替身是调本地 Supabase 的函数 */
export interface PurgeActs {
  /** A 申请注销（进入 7 天冷静期；对象存储里什么都不删） */
  accountDelete(userId: string): Promise<void>;
  /** 冷静期满，永久清除（B1 的 account-purge；对象存储里删掉 A 的全部对象并再列一次确认为 0） */
  accountPurge(userId: string): Promise<void>;
}

export interface PurgeRunEnv {
  store: Pick<ObjStore, 'put' | 'listAll' | 'head'>;
  acts: PurgeActs;
  /** 造的数据，默认 seedObjects()（A、B 用 SEED_USERS 的 id） */
  seed?: readonly SeedObject[];
}

export interface CaseOutcome {
  id: string;
  ok: boolean;
  problems: string[];
  before: ProbeResult;
  afterDelete: ProbeResult;
  afterPurge: ProbeResult;
}

/** 生成器的用例里哪些归这个 runner */
export function purgeCases(cases: readonly GeneratedCase[]): GeneratedCase[] {
  return cases.filter((c) => c.runner === 'objstore' && c.kind === 'account-delete');
}

const fmt = (r: ProbeResult) => (r.mode === 'count' ? `A ${r.a}、B ${r.b}` : r.mode === 'snapshot' ? `${r.digest.split('\n').filter(Boolean).length} 个 key` : JSON.stringify(r.present));

/** 造的数据够不够：count 模式每个选择器（每一段路径）A、B 都至少有一个对象，否则“删完为 0”说明不了问题 */
function coverage(c: GeneratedCase, seed: readonly SeedObject[]): string[] {
  const p = c.objProbe;
  if (!p || p.mode !== 'count') return [];
  const out: string[] = [];
  for (const sel of p.selectors ?? []) {
    for (const who of ['a', 'b'] as const) {
      const user = SEED_USERS[who];
      if (!seed.some((o) => o.bucket === p.bucket && matches(sel, o.key, user))) {
        out.push(`造数据没覆盖 ${p.bucket} 的 ${sel.prefix || '（整桶）'}${sel.pattern ? ` ${sel.pattern}` : ''}（${who.toUpperCase()}）`);
      }
    }
  }
  return out;
}

function judge(c: GeneratedCase, before: ProbeResult, afterDelete: ProbeResult, afterPurge: ProbeResult): string[] {
  const out: string[] = [];
  if (JSON.stringify(afterDelete) !== JSON.stringify(before)) out.push(`冷静期里对象变了：注销前 ${fmt(before)}，account-delete 后 ${fmt(afterDelete)}`);
  if (before.mode === 'count' && afterPurge.mode === 'count') {
    if (before.a === 0 || before.b === 0) out.push(`注销前 A 或 B 没有对象（${fmt(before)}），用例不成立`);
    if (afterPurge.a !== 0) out.push(`account-purge 之后 A 还剩 ${afterPurge.a} 个`);
    if (afterPurge.b !== before.b) out.push(`account-purge 动了 B 的对象：${before.b} → ${afterPurge.b}`);
  } else if (before.mode === 'snapshot' && afterPurge.mode === 'snapshot') {
    if (afterPurge.digest !== before.digest) out.push('noUserData 的桶在注销前后变了');
  } else {
    out.push(`${c.id}：探针模式 ${before.mode} 不是注销用例该有的（count / snapshot）`);
  }
  return out;
}

/**
 * 跑全部注销用例：造一次数据，A 走一遍 account-delete → account-purge，每条用例在三个时间点各探一次。
 * 返回每条用例的结果（ok = false 时 problems 写原因）；cases 里不归这个 runner 的会被忽略
 */
export async function runPurgeCases(cases: readonly GeneratedCase[], env: PurgeRunEnv): Promise<CaseOutcome[]> {
  const mine = purgeCases(cases);
  if (mine.length === 0) throw new Error('purge-runner：没有 runner = objstore 的注销用例');
  const seed = env.seed ?? seedObjects();
  const vars = { user_a: SEED_USERS.a, user_b: SEED_USERS.b };
  const probeAll = () => Promise.all(mine.map((c) => runObjProbe(env.store, c.objProbe ?? { bucket: c.target, mode: 'count' }, vars)));

  await putSeedObjects(env.store, seed);
  const before = await probeAll();
  await env.acts.accountDelete(SEED_USERS.a);
  const afterDelete = await probeAll();
  await env.acts.accountPurge(SEED_USERS.a);
  const afterPurge = await probeAll();

  return mine.map((c, i) => {
    const b = before[i] as ProbeResult, d = afterDelete[i] as ProbeResult, p = afterPurge[i] as ProbeResult;
    const problems = [...coverage(c, seed), ...judge(c, b, d, p)];
    return { id: c.id, ok: problems.length === 0, problems, before: b, afterDelete: d, afterPurge: p };
  });
}

/**
 * 离线替身：account-delete 只记“在冷静期”；account-purge 要求先 account-delete，然后按清单把每个 R2 桶里这个人的对象删光
 * （第一级是 user_id 的段用 deletePrefix，删完它自己再列一次；按第几级目录找人的段列整桶再筛）。
 * 这不是 B1 的 account-purge，只是它对对象存储该做的事的最小模型，让 runner 的流程和判定在不起 Docker 时也能跑通
 */
export function memoryPurgeActs(store: Pick<ObjStore, 'listAll' | 'deleteMany' | 'deletePrefix'>, manifests: readonly Manifest[]): PurgeActs & { pending: Set<string> } {
  const pending = new Set<string>();
  const segs = manifests.flatMap((m) => m.buckets ?? []).filter((b) => b.store === 'r2' && !b.noUserData);
  return {
    pending,
    async accountDelete(user) {
      pending.add(user);
    },
    async accountPurge(user) {
      if (!pending.has(user)) throw new Error('account_purge_not_pending');
      for (const b of segs) {
        const lk = b.userLookup;
        if (!lk || lk.by !== 'pathPattern') throw new Error(`purge 替身：${b.name} 不按路径找人`);
        if (lk.level === 1) {
          await store.deletePrefix(b.name, `${user}/`);
        } else {
          const keys = (await store.listAll(b.name, '')).map((o) => o.key).filter((k) => k.split('/')[lk.level - 1] === user);
          if (keys.length) await store.deleteMany(b.name, keys);
        }
      }
      pending.delete(user);
    },
  };
}
