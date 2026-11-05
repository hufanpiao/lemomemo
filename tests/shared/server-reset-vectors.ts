// 清系统列三方对照的向量：唯一一份写在 supabase/tests/rls/38_server_reset_parity.test.sql（真库跑），这里逐行读出来给 TS 两边用
// （tests/shared/server-reset.test.ts 跑 shared 纯函数，tests/edge/push-dispatch-mem-reset.test.ts 跑替身 edit()）。
// BASE 和 SQL 里 tests.r38_base 必须一样；fmt 和 tests.r38 的返回格式必须一样。
import { readFileSync } from 'node:fs';

export type ResetTable = 'events' | 'todos' | 'anniversaries';
export interface ResetVector { table: ResetTable; old: Record<string, unknown>; applied: Record<string, unknown>; want: string; name: string }

export const BASE: Record<ResetTable, Record<string, unknown>> = {
  events: { title: '测', date: '2026-11-05', remind_days: 0, created_at: 1, updated_at: 1 },
  todos: { title: '测', created_at: 1, updated_at: 1 },
  anniversaries: { kind: 'birthday', name: '测', calendar: 'solar', month: 3, day: 5, created_at: 1, updated_at: 1 },
};

const SQL = new URL('../../supabase/tests/rls/38_server_reset_parity.test.sql', import.meta.url);
const LINE = /^select is\(tests\.r38\('(events|todos|anniversaries)', '([^']*)', '([^']*)'\), '([^']*)', '([^']*)'\);$/;

/** 读出全部向量；有一行以 select is(tests.r38 开头却对不上格式就抛错（免得悄悄少跑） */
export function loadResetVectors(): { vectors: ResetVector[]; plan: number } {
  const text = readFileSync(SQL, 'utf8');
  const vectors: ResetVector[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.startsWith('select is(tests.r38(')) continue;
    const m = LINE.exec(line);
    if (!m) throw new Error(`rls/38 这一行格式不对：${line}`);
    const table = m[1] as ResetTable;
    vectors.push({ table, old: { ...BASE[table], ...(JSON.parse(m[2] as string) as Record<string, unknown>) }, applied: JSON.parse(m[3] as string) as Record<string, unknown>, want: m[4] as string, name: m[5] as string });
  }
  const plan = Number(/select plan\((\d+)\);/.exec(text)?.[1] ?? NaN);
  return { vectors, plan };
}

const cell = (v: unknown): string => (v === null || v === undefined ? '空' : String(v));

/** 同 tests.r38 的返回格式 */
export function fmtReset(table: ResetTable, row: Record<string, unknown>): string {
  const out = [`p=${cell(row['pushed_for'])}`, `d=${cell(row['defer_until'])}`, `n=${cell(row['notified_for'])}`, `s=${cell(row['snooze_at'])}`];
  if (table === 'todos') out.push(`dt=${cell(row['due_time'])}`, `rb=${cell(row['remind_before_min'])}`);
  return out.join(' ');
}
