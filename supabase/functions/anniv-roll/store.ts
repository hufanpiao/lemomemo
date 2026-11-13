// anniv-roll 的数据库读写（supabase-js，service role）：只在 index.ts 里用；逻辑测试用内存替身（tests/edge/anniv-roll.test.ts）。
// 写的都是系统列（next_date、remind_at、archived_at，private.table_meta 的 system_cols）：touch() 不加 rev、不入队。每条写都带 user_id 条件。
// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { inChunks, liveSettings } from '../_shared/user-reads.ts';
import { HEARTBEAT, type RollRow, type RollStore } from './core.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

/** 推算要的列（shared/logic/anniv/next-date.ts 的 annivRecOf）加上系统列；rev 是写回的乐观条件，snooze_at、defer_until 判“还有没到的稍后”（整块评审第 7、8 条） */
export const ROLL_COLS = 'id, user_id, rev, undone, kind, calendar, lunar_variant, month, day, is_leap, year, remind_offsets, remind_time, after_due, created_at, next_date, remind_at, archived_at, snooze_at, defer_until';
const SETTING_KEYS = ['anniv.default_offsets', 'anniv.default_time'];

function must<T>(r: { data: T | null; error: unknown }): T {
  if (r.error) throw new Error('db');
  return r.data as T;
}

export function makeStore(admin: Admin): RollStore {
  return {
    async candidates(lo, hi, limit) {
      // next_date 为空 / 没归档且早于 hi / 已归档但回到 lo 以后（见 core.ts 文件头）；没删、没撤销（整块评审第 9 条）。
      // next_date 为空的排最后：韩国阴历（D1 先不做）这类永远算不出的行不每天排在前面占名额，到期的先滚
      const or = `next_date.is.null,and(archived_at.is.null,next_date.lt.${hi}),and(archived_at.not.is.null,next_date.gte.${lo})`;
      return must(await admin.from('anniversaries').select(ROLL_COLS).is('deleted_at', null).eq('undone', false).or(or)
        .order('next_date', { ascending: true, nullsFirst: false }).order('id').limit(limit)) as unknown as RollRow[];
    },
    async profiles(userIds) {
      const rows = await inChunks(userIds, async (c) => must(await admin.from('profiles').select('user_id, current_tz').in('user_id', c)) as { user_id: string; current_tz: string }[]);
      return new Map(rows.map((r) => [r.user_id, r.current_tz]));
    },
    async settings(userIds) {
      return await liveSettings(admin, userIds, SETTING_KEYS, must);
    },
    async write(row: RollRow, patch) {
      // 乐观条件：rev 和 remind_at 都还是读到的值（读完以后用户改了、push-dispatch 写了都不覆盖，整块评审第 8 条）
      const q = admin.from('anniversaries').update(patch).eq('id', row.id).eq('user_id', row.user_id).eq('rev', row.rev);
      const rows = must(await (row.remind_at === null ? q.is('remind_at', null) : q.eq('remind_at', row.remind_at)).select('id')) as { id: string }[];
      return rows.length === 1;
    },
    async writeHeartbeat(detail) {
      must(await admin.schema('private').from('heartbeat').upsert({ name: HEARTBEAT, at: new Date().toISOString(), detail }, { onConflict: 'name' }));
    },
  };
}
