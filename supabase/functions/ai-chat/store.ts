// ai-chat 的数据库查询（R-492；fn_ai，跑在 _shared/db.ts 的 withAiUser 事务里，app.uid 已设好，fn_own 策略只放本人的行）。
// 用到的授权：events、todos 的列级 select（0002、20261115073000；events.duration_min 20261123100000，查跨天日程）；随手记只经视图 private.ai_chat_notes，纪念日的列级 select 和 fn_own 策略（20261122090000）；
//   第 2 段看图：note_images 的列级 select（0003：id、user_id、note_id、bucket、has_thumb、deleted_at、ai_status、ai_desc、ai_tags）和 fn_own_ai 策略，不新加授权。
// 一律只读没删（deleted_at is null）、没撤销（not undone）的；纪念日不读已归档的。
// 隐私记：随手记不查 public.notes，只查视图 private.ai_chat_notes（security_barrier，定义里写死 not is_private、只含 app.uid 本人的行）；
//   fn_ai 读不到隐私记靠的是视图本身，不靠这里的 where（负责人 11-22“AI 不查隐私记”）。
// 每次最多 ROWS_MAX + 1 行（多读 1 行用来告诉模型“还有更多”）。关键词用 ilike any(数组)，% _ \ 先转义；日子转成文字再出库。
// 四句 SQL 写成导出的常量（参数用 $n，类型都显式转）：runQuery 跑的和真库测试（tests/data-manifest/ai-chat-store.test.ts，PGlite 跑完全部迁移、
//   以 fn_ai 身份跑）是同一份字符串，不手抄。
// 每个事务先把语句超时压到 STMT_TIMEOUT（QUERY_MS，3 秒；db.ts 的 4 分钟是给 cron 的上限，对话一轮总共只有 25 秒）。
import { likeOf, QUERY_MS, ROWS_MAX, type ChatRow, type ToolQuery } from './tools.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** runQuery 只用到事务的 unsafe（_shared/db.ts 的 Tx 满足它）；不 import db.ts：真库测试在 Node 里跑，db.ts 带 npm:postgres 和 Deno */
export interface QueryTx {
  unsafe(sql: string, params?: never[]): PromiseLike<readonly unknown[]>;
}

export const LIMIT = ROWS_MAX + 1;

/** 本事务的语句超时（set local：只在这个事务里有效；QUERY_MS 毫秒） */
export const STMT_TIMEOUT = `set local statement_timeout = '${QUERY_MS}ms'`;

/** 日程最多跨几天（events_duration_min_check 的上限 44640 分钟，迁移 20261117120000、shared/schema/rows.ts 的 EVENT_DURATION_MAX） */
export const EVENT_SPAN_DAYS_MAX = 31;

/**
 * $1 用户、$2 起、$3 止、$4 关键词数组（null 不筛）、$5 条数。
 * 跨天日程（R-444；负责人 11-23 弹窗）：和 [起, 止] 这几天有重叠的都算，前几天开始、跨进起始日的也查出来（迁移 20261123100000 给 fn_ai 读 duration_min）：
 * • 有时刻的：开始 = date + time，结束 = 开始 + duration_min 分钟，结束晚于起始日 0 点就算（正好在 0 点结束的不算跨进来）；
 * • 全天的：按“天数 × 1440”记（≤ 1440 是一天），从 date 起连着这几天；
 * • 先按 date 在 [起 − EVENT_SPAN_DAYS_MAX, 止] 粗筛（走 date 的索引），再算重叠
 */
export const EVENTS_SQL = `select id, title, date::text as date, time, location, note from public.events
  where user_id = $1::uuid and deleted_at is null and not undone
    and date between $2::date - ${EVENT_SPAN_DAYS_MAX} and $3::date
    and (case when time is null then date + (greatest(1, ceil(duration_min / 1440.0))::int - 1) >= $2::date
              else (date + time::time) + make_interval(mins => duration_min) > $2::date::timestamp end)
    and ($4::text[] is null or title ilike any($4::text[]) or location ilike any($4::text[]) or note ilike any($4::text[]))
  order by date, time nulls first limit $5::int`;

/** $1 用户、$2 做完没有（null 不筛）、$3 只要过期的、$4 今天、$5 截止起、$6 截止止、$7 关键词数组、$8 条数 */
export const TODOS_SQL = `select id, title, due::text as due, due_time, done, note from public.todos
  where user_id = $1::uuid and deleted_at is null and not undone
    and ($2::boolean is null or done = $2::boolean)
    and (not $3::boolean or (due is not null and due < $4::date))
    and ($5::date is null or due >= $5::date) and ($6::date is null or due <= $6::date)
    and ($7::text[] is null or title ilike any($7::text[]) or note ilike any($7::text[]))
  order by due nulls last, due_time nulls last limit $8::int`;

/** $1 用户、$2 关键词数组、$3 时区、$4 条数。只查视图（不含隐私记）。
 *  第 2 段：每条另带它的图（images 桶、没删的）张数和已识别的描述；图的描述、标签里有关键词的随手记也算查到 */
export const NOTES_SQL = `select n.id, n.title, n.body, to_char(to_timestamp(n.created_at / 1000.0) at time zone $3::text, 'YYYY-MM-DD') as day,
    coalesce(im.cnt, 0) as images, im.descs
  from private.ai_chat_notes n
  left join lateral (
    select count(*)::int as cnt,
           (array_agg(i.ai_desc order by i.id) filter (where i.ai_status = 'done' and i.ai_desc is not null))[1:4] as descs
      from public.note_images i
     where i.user_id = $1::uuid and i.note_id = n.id and i.bucket = 'images' and i.deleted_at is null) im on true
  where n.user_id = $1::uuid and (n.title ilike any($2::text[]) or n.body ilike any($2::text[])
    or exists (select 1 from public.note_images i
                where i.user_id = $1::uuid and i.note_id = n.id and i.bucket = 'images' and i.deleted_at is null
                  and (i.ai_desc ilike any($2::text[]) or array_to_string(i.ai_tags, ' ') ilike any($2::text[]))))
  order by n.created_at desc limit $4::int`;

/** $1 用户、$2 随手记 id、$3 张数。看随手记里的图（第 2 段 look_note_images）：只经视图 private.ai_chat_notes 连过去，
 *  隐私记（不在视图里）的图连不上；只要 images 桶（隐私记的 vault-images 桶不读）、没删的、**有缩略图的**（只读缩略图，不读原图）；按插入先后 */
export const NOTE_IMAGES_SQL = `select i.id, i.note_id from public.note_images i
    join private.ai_chat_notes n on n.id = i.note_id and n.user_id = i.user_id
  where i.user_id = $1::uuid and i.note_id = $2::uuid and i.bucket = 'images' and i.deleted_at is null and i.has_thumb
  order by i.id limit $3::int`;

/** $1 用户、$2 起、$3 止、$4 条数。next_date 由服务器（push-dispatch、anniv-roll）写，刚新建还没算的为空：
 *  公历的按今年 / 明年的月日补上（日子超出当月的顺延到下月），农历的没算好就不出 */
export const ANNIV_SQL = `select id, name, kind, nd::text as nd, note from (
    select id, name, kind, note, coalesce(next_date, case when calendar = 'solar' then
        case when make_date(extract(year from $2::date)::int, month, 1) + (day - 1) >= $2::date
             then make_date(extract(year from $2::date)::int, month, 1) + (day - 1)
             else make_date(extract(year from $2::date)::int + 1, month, 1) + (day - 1) end end) as nd
      from public.anniversaries
     where user_id = $1::uuid and deleted_at is null and not undone and archived_at is null) a
  where nd between $2::date and $3::date
  order by nd limit $4::int`;

/** 一个查询要跑的 SQL 和参数（真库测试也按这里拿） */
export function sqlOf(uid: string, q: ToolQuery, tz: string): { sql: string; params: unknown[] } {
  switch (q.tool) {
    case 'find_events':
      return { sql: EVENTS_SQL, params: [uid, q.from, q.to, likeOf(q.terms), LIMIT] };
    case 'find_todos': {
      const done = q.status === 'done' ? true : q.status === 'all' ? null : false;
      return { sql: TODOS_SQL, params: [uid, done, q.status === 'overdue', q.today, q.from, q.to, likeOf(q.terms), LIMIT] };
    }
    case 'search_notes':
      return { sql: NOTES_SQL, params: [uid, likeOf(q.terms) ?? [], tz, LIMIT] };
    case 'list_anniversaries':
      return { sql: ANNIV_SQL, params: [uid, q.from, q.to, LIMIT] };
  }
}

/** 查出来的行 → ChatRow */
export function rowsOf(q: ToolQuery, rows: readonly Record<string, unknown>[]): ChatRow[] {
  switch (q.tool) {
    case 'find_events':
      return rows.map((r) => ({ kind: 'event', id: String(r['id']), title: str(r['title']), date: str(r['date']), time: str(r['time']), where: str(r['location']), body: str(r['note']) }));
    case 'find_todos':
      return rows.map((r) => ({ kind: 'todo', id: String(r['id']), title: str(r['title']), date: str(r['due']), time: str(r['due_time']), done: r['done'] === true, body: str(r['note']) }));
    case 'search_notes':
      return rows.map((r) => ({
        kind: 'note', id: String(r['id']), title: str(r['title']), date: str(r['day']), time: null, body: str(r['body']),
        images: typeof r['images'] === 'number' ? r['images'] : 0,
        descs: Array.isArray(r['descs']) ? r['descs'].filter((d): d is string => typeof d === 'string') : [],
      }));
    case 'list_anniversaries':
      return rows.map((r) => ({ kind: 'anniv', id: String(r['id']), title: str(r['name']), date: str(r['nd']), time: null, sub: str(r['kind']), body: str(r['note']) }));
  }
}

export async function runQuery(tx: QueryTx, uid: string, q: ToolQuery, tz: string): Promise<ChatRow[]> {
  await tx.unsafe(STMT_TIMEOUT);
  const { sql, params } = sqlOf(uid, q, tz);
  // postgres.js 的 unsafe 参数类型是它自己的 ParameterOrJSON；这里的值只有字符串、数字、布尔、null、字符串数组
  const rows = await tx.unsafe(sql, params as never[]);
  return rowsOf(q, rows as Record<string, unknown>[]);
}

/** 随手记里有缩略图的一张图（look_note_images 用；缩略图路径由 index.ts 按 user_id、note_id、id 拼，不读存下来的 path） */
export interface NoteImage {
  id: string;
  noteId: string;
}

export async function noteImages(tx: QueryTx, uid: string, noteId: string, limit: number): Promise<NoteImage[]> {
  await tx.unsafe(STMT_TIMEOUT);
  const rows = (await tx.unsafe(NOTE_IMAGES_SQL, [uid, noteId, limit] as never[])) as Record<string, unknown>[];
  return rows.map((r) => ({ id: String(r['id']), noteId: String(r['note_id']) }));
}
