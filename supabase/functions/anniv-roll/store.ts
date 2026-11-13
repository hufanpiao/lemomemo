// anniv-roll 的数据库读写（supabase-js，service role）：只在 index.ts 里用；逻辑测试用内存替身（tests/edge/anniv-roll.test.ts）。
// 写的都是系统列（next_date、remind_at、archived_at，private.table_meta 的 system_cols）：touch() 不加 rev、不入队。每条写都带 user_id 条件。
// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { HEARTBEAT, IN_CHUNK, type RollRow, type RollStore } from './core.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

/** 推算要的列（shared/logic/anniv/next-date.ts 的 annivRecOf）加上系统列 */
export const ROLL_COLS = 'id, user_id, kind, calendar, lunar_variant, month, day, is_leap, year, remind_offsets, remind_time, after_due, created_at, next_date, remind_at, archived_at';
const SETTING_KEYS = ['anniv.default_offsets', 'anniv.default_time'];

function must<T>(r: { data: T | null; error: unknown }): T {
  if (r.error) throw new Error('db');
  return r.data as T;
}

async function chunks<T>(ids: readonly string[], run: (c: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(...(await run(ids.slice(i, i + IN_CHUNK))));
  return out;
}

export function makeStore(admin: Admin): RollStore {
  return {
    async candidates(lo, hi, limit) {
      // next_date 为空 / 没归档且早于 hi / 已归档但回到 lo 以后（见 core.ts 文件头）
      const or = `next_date.is.null,and(archived_at.is.null,next_date.lt.${hi}),and(archived_at.not.is.null,next_date.gte.${lo})`;
      return must(await admin.from('anniversaries').select(ROLL_COLS).is('deleted_at', null).or(or)
        .order('next_date', { ascending: true, nullsFirst: true }).order('id').limit(limit)) as unknown as RollRow[];
    },
    async profiles(userIds) {
      const rows = await chunks(userIds, async (c) => must(await admin.from('profiles').select('user_id, current_tz').in('user_id', c)) as { user_id: string; current_tz: string }[]);
      return new Map(rows.map((r) => [r.user_id, r.current_tz]));
    },
    async settings(userIds) {
      const rows = await chunks(userIds, async (c) => must(await admin.from('settings').select('user_id, key, value').in('user_id', c)
        .in('key', SETTING_KEYS).is('deleted_at', null).eq('undone', false)) as { user_id: string; key: string; value: unknown }[]);
      const out = new Map<string, Record<string, unknown>>();
      for (const r of rows) out.set(r.user_id, { ...(out.get(r.user_id) ?? {}), [r.key]: r.value });
      return out;
    },
    async write(row: RollRow, patch) {
      const q = admin.from('anniversaries').update(patch).eq('id', row.id).eq('user_id', row.user_id);
      const rows = must(await (row.remind_at === null ? q.is('remind_at', null) : q.eq('remind_at', row.remind_at)).select('id')) as { id: string }[];
      return rows.length === 1;
    },
    async writeHeartbeat(detail) {
      must(await admin.schema('private').from('heartbeat').upsert({ name: HEARTBEAT, at: new Date().toISOString(), detail }, { onConflict: 'name' }));
    },
  };
}
