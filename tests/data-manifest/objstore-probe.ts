// 执行对象存储探针（FB-6）：runner 拿生成器产出的 objProbe，经 shared/objstore.ts 列前缀、数个数。
// 存储由调用方传入（CI 打 S3 替身，单测打内存替身），桶名是逻辑名，前缀由 createObjStore 的 bucketPrefix 加。

import type { ObjProbe, ObjSelector } from './sql.ts';

/** shared/objstore.ts 的 ObjStore 里探针用到的两个方法 */
export interface ProbeStore {
  listAll(bucket: string, prefix: string): Promise<{ key: string }[]>;
  head(bucket: string, key: string): Promise<unknown>;
}

export interface ProbeVars {
  user_a: string;
  user_b: string;
  /** head 模式：:old_id、:new_id 对应的 key */
  keys?: Record<string, string>;
}

export type ProbeResult =
  | { mode: 'count'; a: number; b: number }
  | { mode: 'snapshot'; digest: string }
  | { mode: 'head'; present: Record<string, boolean> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 这个 key 是不是 user 的（按选择器） */
export function matches(sel: ObjSelector, key: string, user: string): boolean {
  if (!key.startsWith(sel.prefix.replace('<user>', user))) return false;
  if (sel.level !== null && key.split('/')[sel.level - 1] !== user) return false;
  return sel.pattern === null || new RegExp(sel.pattern).test(key);
}

async function countFor(store: ProbeStore, bucket: string, sels: readonly ObjSelector[], user: string): Promise<number> {
  const seen = new Set<string>();
  for (const sel of sels) {
    for (const o of await store.listAll(bucket, sel.prefix.replace('<user>', user))) {
      if (matches(sel, o.key, user)) seen.add(o.key);
    }
  }
  return seen.size;
}

export async function runObjProbe(store: ProbeStore, probe: ObjProbe, vars: ProbeVars): Promise<ProbeResult> {
  if (!UUID.test(vars.user_a) || !UUID.test(vars.user_b) || vars.user_a === vars.user_b) throw new Error('objProbe：user_a、user_b 要是两个不同的 uuid');
  if (probe.mode === 'count') {
    const sels = probe.selectors ?? [];
    if (sels.length === 0) throw new Error(`objProbe：${probe.bucket} 没有选择器`);
    return { mode: 'count', a: await countFor(store, probe.bucket, sels, vars.user_a), b: await countFor(store, probe.bucket, sels, vars.user_b) };
  }
  if (probe.mode === 'snapshot') {
    const keys = (await store.listAll(probe.bucket, '')).map((o) => o.key).sort();
    return { mode: 'snapshot', digest: keys.join('\n') };
  }
  const present: Record<string, boolean> = {};
  for (const k of probe.keys ?? []) {
    const key = vars.keys?.[k];
    if (!key) throw new Error(`objProbe：没给 ${k} 对应的 key`);
    present[k] = (await store.head(probe.bucket, key)) !== null;
  }
  return { mode: 'head', present };
}
