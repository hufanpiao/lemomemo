// 契约测试框架（前端这一侧，架构 0.27 第 1 点、第 9 节契约测试）
// • 契约测试打本地 Supabase（`supabase start`），由环境变量给地址和 anon key；没有就整组跳过并写明原因
// • 每条用 contract(id, …) 登记一个稳定的 id；“旧版客户端打新数据库”只跑 subset.json 里列出的 id
//   （CI 取上一个发布 tag 的这批用例对当前迁移跑，LEMO_COMPAT_SUBSET=1 时生效；4.0.0 还没有上一个 tag）
// • 数据库那一侧的用例（pull、patch、冲突、RLS）由后端随各批往里加，这里只提供框架
import { describe, it } from 'vitest';
import subset from './subset.json' with { type: 'json' };

export interface LocalSupabase {
  url: string;
  anonKey: string;
}

/** 本地 Supabase 的地址（`supabase status -o env` 给出的 API_URL、ANON_KEY） */
export function localSupabase(env: Readonly<Record<string, string | undefined>> = process.env): LocalSupabase | null {
  const url = env.LEMO_TEST_SUPABASE_URL ?? env.API_URL;
  const anonKey = env.LEMO_TEST_ANON_KEY ?? env.ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export const COMPAT_IDS: readonly string[] = subset.ids;
const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** 当前是否在跑“旧版客户端子集” */
export const subsetOnly = (env: Readonly<Record<string, string | undefined>> = process.env): boolean =>
  env.LEMO_COMPAT_SUBSET === '1';

const registered = new Set<string>();

/** 已登记的契约用例 id（自测用） */
export function registeredIds(): readonly string[] {
  return [...registered];
}

/**
 * 登记一条契约测试。fn 拿到本地 Supabase 的地址。
 * 没有本地 Supabase：跳过（原因写在用例名里）；子集模式下不在 subset.json 的：跳过。
 */
export function contract(id: string, title: string, fn: (sb: LocalSupabase) => Promise<void> | void): void {
  if (!ID_RE.test(id)) throw new Error(`contract_bad_id:${id}`);
  if (registered.has(id)) throw new Error(`contract_duplicate_id:${id}`);
  registered.add(id);
  const sb = localSupabase();
  const name = `[${id}] ${title}`;
  if (!sb) {
    describe(name, () => {
      it.skip('跳过：没有本地 Supabase（设置 LEMO_TEST_SUPABASE_URL、LEMO_TEST_ANON_KEY，或先 supabase start）', () => {});
    });
    return;
  }
  if (subsetOnly() && !COMPAT_IDS.includes(id)) {
    describe(name, () => {
      it.skip('跳过：不在旧版客户端子集（tests/compat/subset.json）里', () => {});
    });
    return;
  }
  it(name, () => fn(sb));
}
