// 本机缓存的行 → 前端 B 月历、周视图纯逻辑的输入（B2 FA-3）
// • 本机行的列都是 unknown（可能是旧版本写的、也可能缺列），这里逐列取：类型不对的给安全的默认值，
//   连 id 或日期都没有的行直接跳过，免得一条坏行让整个月历画不出来
// • 删除、撤销不在这里筛：交给纯逻辑的 isLiveRow（deleted_at、undone 原样带过去）
// 纯 TS
import type { DateStr } from '../../../../shared/core/date.ts';
import type { CalEvent, CalItems, CalTodo } from '../../../../shared/logic/calendar/cal-items.ts';

export type Row = Readonly<{ id: string } & Record<string, unknown>>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isDate = (v: unknown): v is DateStr => typeof v === 'string' && DATE.test(v);

function eventOf(r: Row): CalEvent | null {
  if (typeof r.id !== 'string' || !isDate(r['date'])) return null;
  const time = typeof r['time'] === 'string' && HM.test(r['time']) ? r['time'] : null;
  return {
    id: r.id,
    title: str(r['title']),
    short: strOrNull(r['short']),
    project: str(r['project']),
    date: r['date'],
    time,
    // 时区缺失或无效时，纯逻辑（placeEvent）按设备时区的时刻照样显示
    tz: strOrNull(r['tz']),
    duration_min: Math.max(0, Math.trunc(num(r['duration_min'], 0))),
    created_at: num(r['created_at'], 0),
    deleted_at: numOrNull(r['deleted_at']),
    undone: r['undone'] === true,
  };
}

function todoOf(r: Row): CalTodo | null {
  if (typeof r.id !== 'string') return null;
  return {
    id: r.id,
    title: str(r['title']),
    short: strOrNull(r['short']),
    project: str(r['project']),
    due: isDate(r['due']) ? r['due'] : null,
    done: r['done'] === true,
    created_at: num(r['created_at'], 0),
    deleted_at: numOrNull(r['deleted_at']),
    undone: r['undone'] === true,
  };
}

/** 两个集合 → CalItems（坏行跳过） */
export function calItemsOf(events: readonly Row[], todos: readonly Row[]): CalItems {
  const ev: CalEvent[] = [];
  for (const r of events) {
    const e = eventOf(r);
    if (e) ev.push(e);
  }
  const td: CalTodo[] = [];
  for (const r of todos) {
    const t = todoOf(r);
    if (t) td.push(t);
  }
  return { events: ev, todos: td };
}

/**
 * 待办的截止时刻（todos.due_time，“HH:MM” → 当天第几分钟）：周视图把空心圆画在那个时刻（架构 5.12 0.51、设计审查 M2）。
 * CalTodo（前端 B 的纯逻辑类型）没有这一列，这里单独给一张表；没有 due_time、格式不对的不进表（画在泳道末端）
 */
export function todoDueMinutes(todos: readonly Row[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const r of todos) {
    const v = r['due_time'];
    if (typeof r.id !== 'string' || typeof v !== 'string') continue;
    const m = /^([01]\d|2[0-3]):([0-5]\d)/.exec(v);
    if (m) out.set(r.id, Number(m[1]) * 60 + Number(m[2]));
  }
  return out;
}

