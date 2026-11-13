// shared/logic/notes/note-convert.ts（TC-B4-08 的映射一侧；B4 任务单 S8）：转出的行原样过 insertSchema、截断不破字、
// 没有提醒字段、标题取自正文第一行时备注不重复；converted_to 的形状、追加和封顶（库约束按 jsonb::text 的写法量）
import { describe, expect, it } from 'vitest';
import type { DateStr } from '../../../shared/core/date.ts';
import type { Tz } from '../../../shared/core/tz.ts';
import { CONVERTED_TO_MAX, convertedToAfter, convertedToSchema, convertRow, convertTooLong, type ConvertedTo } from '../../../shared/logic/notes/note-convert.ts';
import { noteHeadline } from '../../../shared/logic/notes/note-headline.ts';
import { remindAtOf } from '../../../shared/logic/remind.ts';
import { insertSchema } from '../../../shared/schema/rows.ts';

const TZ = 'Asia/Seoul' as Tz;
const NOW = Date.UTC(2026, 10, 10, 3, 0);
const NOTE_ID = '00000000-0000-4000-8000-0000000000a1';
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = { id: uid(1), batchId: uid(2), now: NOW, today: '2026-11-10' as DateStr, tz: TZ };
const note = (title: string | null, body: string) => ({ id: NOTE_ID, title, body });

/** 库里 converted_to::text 的写法（jsonb 输出：键按长度排、冒号和逗号后有空格），约束量的是它的字节数 */
const jsonbText = (v: ConvertedTo): string => `[${v.map((x) => `{"id": "${x.id}", "kind": "${x.kind}"}`).join(', ')}]`;
const bytes = (s: string): number => new TextEncoder().encode(s).length;
const ok = (table: 'todos' | 'events', row: unknown): boolean => insertSchema(table).safeParse(row).success;
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('convertRow：转成待办（TC-B4-08）', () => {
  const r = convertRow(note('买牛奶', '低脂的\n两盒'), 'todo', ctx);
  it('标题原样、备注是正文（换行保留）；没截止没提醒、本机新建口径；from_note_id 是随手记 id；过 insertSchema', () => {
    expect(r?.table).toBe('todos');
    if (r?.table !== 'todos') return;
    expect(r.row.title).toBe('买牛奶');
    expect(r.row.note).toBe('低脂的\n两盒');
    expect(r.row.due).toBeNull();
    expect(r.row.due_time).toBeNull();
    expect(r.row.remind_before_min).toBeNull();
    expect(r.row.done).toBe(false);
    expect(r.row.source).toBe('page');
    expect(r.row.raw_text).toBe('');
    expect(r.row.from_note_id).toBe(NOTE_ID);
    expect(r.row.batch_id).toBe(ctx.batchId);
    expect(r.row.id).toBe(ctx.id);
    expect(ok('todos', r.row)).toBe(true);
  });
  it('算不出提醒时刻（转出的行不带 remind 标记的前提）', () => {
    if (r?.table !== 'todos') throw new Error('not_todo');
    expect(remindAtOf('todo', r.row, TZ, NOW)).toBeNull();
  });
});

describe('convertRow：转成日程（TC-B4-08）', () => {
  const r = convertRow(note('买牛奶', '低脂的\n两盒'), 'event', ctx);
  it('date 是传入的 today、全天、时长 60；过 insertSchema；没有 from_note_id', () => {
    expect(r?.table).toBe('events');
    if (r?.table !== 'events') return;
    expect(r.row.date).toBe('2026-11-10');
    expect(r.row.time).toBeNull();
    expect(r.row.tz).toBeNull();
    expect(r.row.remind_min).toBeNull();
    expect(r.row.remind_days).toBeNull();
    expect(r.row.duration_min).toBe(60);
    expect(r.row.note).toBe('低脂的\n两盒');
    expect(Object.keys(r.row)).not.toContain('from_note_id');
    expect(ok('events', r.row)).toBe(true);
  });
  it('算不出提醒时刻（全天、remind_days 为 null）', () => {
    if (r?.table !== 'events') throw new Error('not_event');
    expect(remindAtOf('event', r.row, TZ, NOW, undefined, '09:00')).toBeNull();
  });
});

describe('convertRow：共同口径', () => {
  it('两种行都不带 deleted_at、undone、ai_status', () => {
    for (const kind of ['todo', 'event'] as const) {
      const keys = Object.keys(convertRow(note('t', 'b'), kind, ctx)?.row ?? {});
      for (const k of ['deleted_at', 'undone', 'ai_status']) expect(keys).not.toContain(k);
      expect(keys.length).toBeGreaterThan(0);
    }
  });
  it('标题为空或只有空白、正文也空 → null', () => {
    expect(convertRow(note(null, ''), 'todo', ctx)).toBeNull();
    expect(convertRow(note('   ', ' \n\t\n '), 'event', ctx)).toBeNull();
  });
  it('正文为空或全空白 → 备注是空串', () => {
    for (const body of ['', '  \n \n']) {
      expect(convertRow(note('买牛奶', body), 'todo', ctx)?.row.note).toBe('');
    }
  });
});

describe('convertRow：没有标题的随手记（底部输入行记下的都是这种）', () => {
  it('一行 → 标题是这一行、备注是空串（不重复）', () => {
    const r = convertRow(note(null, '买牛奶'), 'todo', ctx);
    expect(r?.row.title).toBe('买牛奶');
    expect(r?.row.note).toBe('');
  });
  it('多行 → 标题是第一个非空行，备注是第二行起（换行保留）', () => {
    const r = convertRow(note('  ', '\n 买菜 \n鸡蛋\n\n猫砂\n'), 'event', ctx);
    expect(r?.row.title).toBe('买菜');
    expect(r?.row.note).toBe('鸡蛋\n\n猫砂');
  });
  it('第一行超过 160 个 UTF-16 单元、末尾是 emoji：截到 160 以内不出半个 emoji，是原行前缀；备注保留全文', () => {
    const line = `${'a'.repeat(159)}😀`;
    const body = `${line}\n第二行`;
    const r = convertRow(note(null, body), 'todo', ctx);
    const title = r?.row.title ?? '';
    expect(title.length).toBeLessThan(161);
    expect(lone.test(title)).toBe(false);
    expect(line.startsWith(title)).toBe(true);
    expect(title).toBe('a'.repeat(159));
    expect(r?.row.note).toBe(body);
    expect(ok('todos', r?.row)).toBe(true);
  });
  it('noteHeadline：有标题用标题、正文整段；没标题取第一个非空行', () => {
    expect(noteHeadline('题', 'a\nb')).toEqual({ title: '题', rest: 'a\nb', fromBody: false });
    expect(noteHeadline(null, '\n第一\n第二')).toEqual({ title: '第一', rest: '第二', fromBody: true });
    expect(noteHeadline(undefined, undefined)).toEqual({ title: '', rest: '', fromBody: true });
  });
});

describe('convertRow：显式标题超长', () => {
  it('标题 159 个 a + emoji + 更多：截成 159 个 a、不留落单的代理对、过 insertSchema（标题截短不算超长）；备注照旧是正文', () => {
    const title = `${'a'.repeat(159)}😀后面还有`;
    for (const kind of ['todo', 'event'] as const) {
      const r = convertRow(note(title, 'x'), kind, ctx);
      expect(r?.row.title).toBe('a'.repeat(159));
      expect(lone.test(r?.row.title ?? '')).toBe(false);
      expect(r?.row.note).toBe('x');
      expect(ok(kind === 'todo' ? 'todos' : 'events', r?.row)).toBe(true);
    }
  });
  it('标题刚好 160 个单元：原样', () => {
    const r = convertRow(note('a'.repeat(160), 'x'), 'todo', ctx);
    expect(r?.row.title).toBe('a'.repeat(160));
  });
});

describe('convertRow：长正文截断', () => {
  it('正文 20000 字夹 emoji：备注不超过 2000、是原文前缀、不截半个字，过 insertSchema（convertNote 先按 convertTooLong 拦下，这里只验截断本身）', () => {
    const body = `${'记😀'.repeat(6666)}记记`;
    expect(body.length).toBe(20000);
    for (const kind of ['todo', 'event'] as const) {
      const r = convertRow(note('长文', body), kind, ctx);
      const n = r?.row.note ?? '';
      expect(n.length).toBeLessThan(2001);
      expect(n.length).toBeGreaterThan(1990);
      expect(body.startsWith(n)).toBe(true);
      expect(lone.test(n)).toBe(false);
      expect(ok(kind === 'todo' ? 'todos' : 'events', r?.row)).toBe(true);
    }
  });
});

describe('convertedToAfter', () => {
  const ref = (n: number, kind: 'todo' | 'event' = 'todo') => ({ kind, id: uid(n) });
  it('prev 为 null / undefined → 只有新的一项；已有 1 项 → 新的接在后面；同一个 id 再加不重复（挪到最后）', () => {
    expect(convertedToAfter(null, ref(1))).toEqual([ref(1)]);
    expect(convertedToAfter(undefined, ref(1, 'event'))).toEqual([ref(1, 'event')]);
    expect(convertedToAfter([ref(1)], ref(2, 'event'))).toEqual([ref(1), ref(2, 'event')]);
    expect(convertedToAfter([ref(1), ref(2)], ref(1))).toEqual([ref(2), ref(1)]);
  });
  it('已有 20 项再加 → 仍是 20 项、最旧的一项没了；按 jsonb::text 量也在 2048 字节以内', () => {
    const full = Array.from({ length: CONVERTED_TO_MAX }, (_, i) => ref(i + 1, i % 2 ? 'event' : 'todo'));
    const next = convertedToAfter(full, ref(99, 'event'));
    expect(next).toHaveLength(20);
    expect(next?.[0]).toEqual(ref(2, 'event'));
    expect(next?.[19]).toEqual(ref(99, 'event'));
    const text = jsonbText(next ?? []);
    expect(bytes(text)).toBeLessThan(2049);
    expect(bytes(text)).toBeGreaterThan(1250);
  });
  it('prev 认不出（对象、项缺 id、kind 不认识）→ null，不覆盖', () => {
    expect(convertedToAfter({ kind: 'todo', id: uid(1) }, ref(2))).toBeNull();
    expect(convertedToAfter([{ kind: 'todo' }], ref(2))).toBeNull();
    expect(convertedToAfter([{ kind: 'note', id: uid(1) }], ref(2))).toBeNull();
  });
});

describe('convertedToSchema', () => {
  const item = (n: number) => ({ kind: 'todo', id: uid(n) });
  it('20 项能过、21 项被拒；kind 为 note 被拒；多一个键被拒', () => {
    expect(convertedToSchema.safeParse(Array.from({ length: 20 }, (_, i) => item(i))).success).toBe(true);
    expect(convertedToSchema.safeParse(Array.from({ length: 21 }, (_, i) => item(i))).success).toBe(false);
    expect(convertedToSchema.safeParse([{ kind: 'note', id: uid(1) }]).success).toBe(false);
    expect(convertedToSchema.safeParse([{ kind: 'todo', id: uid(1), at: 1 }]).success).toBe(false);
  });
});

describe('convertTooLong（R-414：备注放不下的不让转）', () => {
  it('有标题：正文就是备注，2000 字能转、2001 字不能', () => {
    expect(convertTooLong({ title: '长文', body: '字'.repeat(2000) })).toBe(false);
    expect(convertTooLong({ title: '长文', body: '字'.repeat(2001) })).toBe(true);
  });
  it('没标题：第一行当标题、其余进备注，只按其余几行算；第一行放不进标题时备注放全文', () => {
    expect(convertTooLong({ title: '', body: `第一行\n${'字'.repeat(2000)}` })).toBe(false);
    expect(convertTooLong({ title: null, body: 'a'.repeat(3000) })).toBe(true);
  });
  it('和 convertRow 同一口径：判超长的正好是备注会被截短的', () => {
    for (const body of ['字'.repeat(1999), '字'.repeat(2000), '字'.repeat(2001), '😀'.repeat(1000), '😀'.repeat(1001)]) {
      const r = convertRow({ id: NOTE_ID, title: '标题', body }, 'todo', ctx);
      expect(convertTooLong({ title: '标题', body }), `${body.length}`).toBe(r?.row.note !== body);
    }
  });
});
