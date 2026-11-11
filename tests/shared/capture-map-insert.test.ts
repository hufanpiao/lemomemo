// capture-map 产出的新增行逐行按“新增”口径校验（11-07 前端 A 查出：原单测只核对 eventsWrite / todosWrite 整行，
// 那是 insert 和 update 可写列的并集，新增时带了只能 update 的 deleted_at、undone 也拦不住，e2e 才报 invalid_row）。
// 11-09 起 captureRow 不再带 deleted_at、undone（库默认 null、false），captureRow 的行有两个去处，这里两边都核：
//   • 客户端（features/plus 经 outbox）：events、todos 原样过 shared/schema/rows.ts 的 insertSchema(table)（严格对象，多一列就挂）；
//   • claude-intake（intake_insert）：整行原样写，每一列必须在迁移 20261107100000 的 allowed 名单里，
//     或在 fixed 名单里且值一模一样（纪念日没有 insertSchema，只能按这份名单核）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { captureRow, type CaptureCtx, type CaptureItem, type CaptureRow } from '../../shared/logic/capture-map.ts';
import { insertSchema, WRITE_RULES } from '../../shared/schema/rows.ts';

const NOW = Date.UTC(2026, 10, 2, 1, 0);
const ctx = (over: Partial<CaptureCtx> = {}): CaptureCtx => ({
  id: '00000000-0000-4000-8000-000000000001', batchId: '00000000-0000-4000-8000-0000000000b1', now: NOW,
  today: '2026-11-02' as CaptureCtx['today'], tz: 'Asia/Seoul' as CaptureCtx['tz'], source: 'page', rawText: '原话', origin: 'ai', ...over,
});
const item = (over: Partial<CaptureItem> = {}): CaptureItem => ({
  kind: 'todo', title: '买牛奶', date: null, time: null, duration_min: null, due: null, important: false,
  project: null, body: null, short: null, anniv: null, ...over,
});

/** 每种 kind、每条分支各一行（日程有无时刻、待办有无截止日子 / 时刻、纪念日阳历 / 阴历闰月、AI / 本机规则、三种来源） */
const CASES: { name: string; item: CaptureItem; ctx?: Partial<CaptureCtx>; table: CaptureRow['table'] }[] = [
  { name: '日程：有日子有时刻、AI 简称', item: item({ kind: 'event', title: '开会', date: '2026-11-03' as CaptureItem['date'], time: '15:00', duration_min: 30, short: '会', project: '工作', body: '带电脑' }), table: 'events' },
  { name: '日程：没日子没时刻（记今天、全天）', item: item({ kind: 'event', title: '体检' }), table: 'events' },
  { name: '日程：语音、本机规则', item: item({ kind: 'event', title: '理发', time: '09:30', short: '剪' }), ctx: { source: 'voice', origin: 'rule' }, table: 'events' },
  { name: '待办：只有标题', item: item(), table: 'todos' },
  { name: '待办：有截止日子和时刻、重要', item: item({ due: '2026-11-04' as CaptureItem['due'], time: '18:00', important: true, short: '奶' }), table: 'todos' },
  { name: '待办：只说时刻（记今天）、经连接码', item: item({ time: '07:00' }), ctx: { source: 'chat' }, table: 'todos' },
  { name: '纪念日：阳历生日', item: item({ kind: 'anniv', title: '妈妈生日', anniv: { type: 'birthday', calendar: 'solar', month: 3, day: 5, is_leap: false, year: 1960 } }), table: 'anniversaries' },
  { name: '纪念日：阴历闰月倒数日', item: item({ kind: 'anniv', title: '倒数', body: '备注', anniv: { type: 'countdown', calendar: 'lunar', month: 4, day: 1, is_leap: true, year: null } }), table: 'anniversaries' },
];

/** 读迁移里 intake_insert 的 allowed、fixed 两份名单（和服务器用的是同一份文字） */
function intakeLists(): { allowed: Record<string, string[]>; fixed: Record<string, Record<string, unknown>> } {
  const sql = readFileSync(new URL('../../supabase/migrations/20261107100000_core_my_ai_usage.sql', import.meta.url), 'utf8');
  const grab = (name: string): unknown => {
    const m = new RegExp(`${name} constant jsonb := '([^']*)'`).exec(sql);
    if (!m) throw new Error(`迁移里找不到 ${name} 名单`);
    return JSON.parse(m[1] as string);
  };
  return { allowed: grab('allowed') as Record<string, string[]>, fixed: grab('fixed') as Record<string, Record<string, unknown>> };
}

describe('capture-map 新增行逐行按新增口径校验', () => {
  for (const { name, item: it0, ctx: c, table } of CASES) it(`${name} → ${table}`, () => {
    const r = captureRow(it0, ctx(c));
    expect(r?.table).toBe(table);
    if (!r) return;

    // 不带只能 update 的列（三张表都不带，纪念日也一样）
    for (const k of WRITE_RULES.events.updateOnly) expect(k in r.row, k).toBe(false);
    // 客户端：events、todos 原样过 insertSchema
    if (r.table !== 'anniversaries') {
      const p = insertSchema(r.table).safeParse(r.row);
      expect(p.success, JSON.stringify(p.error?.issues)).toBe(true);
    }

    // claude-intake：整行原样过 intake_insert 的列名单
    const { allowed, fixed } = intakeLists();
    const ok = allowed[r.table] ?? [];
    const fx = fixed[r.table] ?? {};
    const bad = Object.entries(r.row).filter(([k, v]) => !ok.includes(k) && !(Object.hasOwn(fx, k) && JSON.stringify(fx[k]) === JSON.stringify(v)));
    expect(bad).toEqual([]);
  });

  it('全部 kind 都覆盖到了：events、todos、anniversaries 各有用例，随手记返回 null、缺 anniv 的纪念日返回 null', () => {
    expect([...new Set(CASES.map((x) => x.table))].sort()).toEqual(['anniversaries', 'events', 'todos']);
    expect(captureRow(item({ kind: 'note', body: '随手' }), ctx())).toBeNull();
    expect(captureRow(item({ kind: 'anniv', anniv: null }), ctx())).toBeNull();
  });
});

describe('captureRow 的截断：按 UTF-16 单元截（同 insertSchema 的 max）、不截半个字', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const E = '😀';
  for (const kind of ['event', 'todo'] as const) it(`${kind}：标题、备注、原话、项目都超长且全是 emoji → 过 insertSchema、是原文前缀、没有落单的代理对`, () => {
    const long = { title: E.repeat(200), body: E.repeat(1500), project: E.repeat(30) };
    const r = captureRow(item({ kind, ...long }), ctx({ rawText: E.repeat(1500) }));
    if (!r || r.table === 'anniversaries') throw new Error('no_row');
    const p = insertSchema(r.table).safeParse(r.row);
    expect(p.success, JSON.stringify(p.error?.issues)).toBe(true);
    for (const [k, src] of [['title', long.title], ['note', long.body], ['raw_text', E.repeat(1500)], ['project', long.project]] as const) {
      const v = r.row[k];
      expect(src.startsWith(v), k).toBe(true);
      expect(lone.test(v), k).toBe(false);
    }
    expect([r.row.title.length, r.row.note.length, r.row.raw_text.length, r.row.project.length]).toEqual([160, 2000, 2000, 40]);
  });
});
