// shared/schema/ai.ts、shared/logic/parse/past-date.ts、shared/logic/capture-map.ts（B3 任务单 BE-1、BE-2、S10、M10；架构第 7 节输出结构、0.29 第 17c 条、续第 36、68 条）。
// 本机规则和 AI 输出共用这一套：AI 的键白名单、按 kind 清字段、过去的月日几号要问（confirm 由服务器算）、行映射能原样过 insertSchema（新增口径，不带只能 update 的列）。
// Vitest 和 Deno（deno task test）都跑。
import { describe, expect, it } from 'vitest';
import { aiResponse, checkParseOutput, checkVoiceOutput, normLocale, normProjects, type AiCheckCtx, type AiItem } from '../../shared/schema/ai.ts';
import { captureRow, type CaptureCtx } from '../../shared/logic/capture-map.ts';
import { inAiRange, pastDate, resolveBasis } from '../../shared/logic/parse/past-date.ts';
import { insertSchema } from '../../shared/schema/rows.ts';

// 2026-10-28（周三）12:00 首尔 = 03:00 UTC
const NOW = Date.UTC(2026, 9, 28, 3, 0);
const SEOUL = 'Asia/Seoul';
const ALL: AiCheckCtx = { now: NOW, tz: SEOUL, features: ['event', 'todo', 'note', 'anniv'] };
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BATCH = '1f8fad5b-d9cb-469f-a165-70867728950e';

const ev = (o: Record<string, unknown> = {}) => ({ kind: 'event', title: '开会', date: '2026-10-29', time: '15:00', date_basis: 'rel', ...o });
const first = (r: ReturnType<typeof checkParseOutput>): AiItem => {
  if (!r.ok) throw new Error(`expected ok, got ${r.invalid_reasons.join(',')}`);
  const it = r.value.items[0];
  if (!it) throw new Error('no item');
  return it;
};
const reasons = (r: ReturnType<typeof checkParseOutput>) => (r.ok ? [] : r.invalid_reasons);

describe('ai.ts：AI 输出校验（第 7 节）', () => {
  it('合格的一条日程：补齐缺省字段，confirm 为 null', () => {
    const it = first(checkParseOutput({ items: [ev()] }, ALL));
    expect(it).toEqual({
      kind: 'event', title: '开会', date: '2026-10-29', time: '15:00', duration_min: null, due: null, important: false,
      project: null, body: null, short: null, date_basis: 'rel', anniv: null, confirm: null,
    });
  });

  it('安全审建议 5：title、project、short 去掉控制字符和双向覆盖字符，body 留换行和制表符；去完是空的标题拒收（和空标题同一口径）', () => {
    const dirty = ev({ title: '开\u202E会\u0007\u2066', project: 'P\u200F1\n', short: '会\u202D', body: '第一行\n第二行\t末尾\u202E\u0000\r' });
    const it = first(checkParseOutput({ items: [dirty] }, ALL));
    expect(it.title).toBe('开会');
    expect(it.project).toBe('P1');
    expect(it.short).toBe('会');
    expect(it.body).toBe('第一行\n第二行\t末尾');
    expect(reasons(checkParseOutput({ items: [ev({ title: '\u202E\u2069 \u0001' })] }, ALL))).toEqual(['out_of_range']);
    // 语音那一路同一套
    const v = checkVoiceOutput({ transcript: '开会', items: [ev({ title: '开会\u202E' })] }, ALL);
    expect(v.ok && v.value.items[0]?.title).toBe('开会');
  });

  it('TC-B3-05：简称最多 2 个字形簇；3 个算 out_of_range', () => {
    expect(first(checkParseOutput({ items: [ev({ short: '会议' })] }, ALL)).short).toBe('会议');
    expect(first(checkParseOutput({ items: [ev({ short: '👨\u200D👩\u200D👧会' })] }, ALL)).short).toBe('👨\u200D👩\u200D👧会');
    expect(reasons(checkParseOutput({ items: [ev({ short: '开会了' })] }, ALL))).toEqual(['out_of_range']);
  });

  it('TC-B3-42：AI 自己带的 confirm 不采用，由服务器按 basis 重算', () => {
    const it = first(checkParseOutput({ items: [ev({ date: '2026-10-01', date_basis: 'md', confirm: { past: '2030-01-01', next: '2030-01-02' } })] }, ALL));
    expect(it.confirm).toEqual({ past: '2026-10-01', next: '2027-10-01' });
  });

  it('TC-B3-50：有日子没 basis 整份退回（missing_date_basis），不按 rel 静默保存、不只丢这一条', () => {
    const r = checkParseOutput({ items: [ev(), ev({ date_basis: undefined })] }, ALL);
    expect(r.ok).toBe(false);
    expect(reasons(r)).toEqual(['missing_date_basis']);
    // 没日子却给了 basis 也是结构不合格
    expect(reasons(checkParseOutput({ items: [ev({ date: null })] }, ALL))).toEqual(['schema']);
  });

  it('TC-B3-45：对不上 kind 的字段清掉、不整份拒收；多余键、超范围、结构不合格各归一类', () => {
    const r = checkParseOutput({
      items: [
        ev(),
        { kind: 'anniv', title: '妈妈生日', due: '2026-11-05', time: '09:00', date_basis: 'rel', anniv: { type: 'birthday', calendar: 'solar', month: 11, day: 5 } },
        { kind: 'note', title: '想法', short: '想法', time: '10:00' },
      ],
    }, ALL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [, a, n] = r.value.items;
    expect([a?.due, a?.time, a?.date_basis, a?.anniv?.is_leap, a?.anniv?.year]).toEqual([null, null, null, false, null]);
    expect([n?.short, n?.time]).toEqual([null, null]);
    expect(reasons(checkParseOutput({ items: [ev({ foo: 1 })] }, ALL))).toEqual(['not_whitelisted']);
    expect(reasons(checkParseOutput({ items: [ev()], intent: 'record' }, ALL))).toEqual(['not_whitelisted']);   // Q2：模型不给 intent
    expect(reasons(checkParseOutput({ items: [ev({ duration_min: 2000 })] }, ALL))).toEqual(['out_of_range']);
    expect(reasons(checkParseOutput({ items: Array.from({ length: 11 }, () => ev()) }, ALL))).toEqual(['out_of_range']);
    expect(reasons(checkParseOutput({ items: [ev({ time: '25:00' })] }, ALL))).toEqual(['schema']);
    expect(reasons(checkParseOutput('not json', ALL))).toEqual(['schema']);
  });

  it('TC-B3-26、27：类型不在这个人能用的里面算 not_whitelisted（开关关着时 anniv 不收）', () => {
    const anniv = { kind: 'anniv', title: '妈妈生日', anniv: { type: 'birthday', calendar: 'solar', month: 11, day: 5 } };
    expect(reasons(checkParseOutput({ items: [anniv] }, { ...ALL, features: ['event', 'todo'] }))).toEqual(['not_whitelisted']);
    expect(checkParseOutput({ items: [anniv] }, ALL).ok).toBe(true);
    expect(reasons(checkParseOutput({ items: [{ kind: 'anniv', title: '缺 anniv' }] }, ALL))).toEqual(['schema']);
  });

  it('TC-B3-44：待办只给了截止时刻没给日子：记今天、basis rel；日程、待办只看各自的日期列', () => {
    const t = first(checkParseOutput({ items: [{ kind: 'todo', title: '交报告', time: '17:00' }] }, ALL));
    expect([t.due, t.time, t.date_basis, t.date]).toEqual(['2026-10-28', '17:00', 'rel', null]);
    const t2 = first(checkParseOutput({ items: [{ kind: 'todo', title: '交稿', date: '2026-10-30', due: '2026-10-30', date_basis: 'rel' }] }, ALL));
    expect([t2.date, t2.due]).toEqual([null, '2026-10-30']);
  });

  it('TC-B3-52、53：月日在任何一年都没有（11-31）是 bad_date；超出前 1 年后 5 年是 out_of_range', () => {
    expect(reasons(checkParseOutput({ items: [ev({ date: '2026-11-31', date_basis: 'md' })] }, ALL))).toEqual(['bad_date']);
    expect(reasons(checkParseOutput({ items: [ev({ date: '2026-02-30', date_basis: 'ymd' })] }, ALL))).toEqual(['bad_date']);
    expect(reasons(checkParseOutput({ items: [ev({ date: '2035-01-01', date_basis: 'ymd' })] }, ALL))).toEqual(['out_of_range']);
  });

  it('ai-voice 多一个 transcript；返回结构 aiResponse 认得服务器包的外层', () => {
    const v = checkVoiceOutput({ transcript: '明天下午三点开会', items: [ev()] }, ALL);
    expect(v.ok && v.value.transcript).toBe('明天下午三点开会');
    const it = first(checkParseOutput({ items: [ev()] }, ALL));
    expect(aiResponse.safeParse({ intent: 'record', confidence: 1, items: [it], quota_left: 49 }).success).toBe(true);
    expect(aiResponse.safeParse({ intent: 'ask', confidence: 1, items: [], quota_left: 49 }).success).toBe(false);
    expect(aiResponse.safeParse({ fallback: true, reason: 'vault_ai_off' }).success).toBe(true);
    expect(aiResponse.safeParse({ consent_required: true }).success).toBe(true);
  });

  it('入参规整：locale 只认 ko 开头为韩文；项目名去空、截 40 字、最多 30 个', () => {
    expect([normLocale('ko-KR'), normLocale('zh-CN'), normLocale(undefined), normLocale('kor')]).toEqual(['ko', 'zh', 'zh', 'zh']);
    const ps = normProjects(['  NEOX ', '', 7, 'x'.repeat(50), ...Array.from({ length: 40 }, (_, i) => `p${i}`)]);
    expect(ps.length).toBe(30);
    expect(ps[0]).toBe('NEOX');
    expect(ps[1]?.length).toBe(40);
  });
});

describe('past-date.ts：过去的月日、几号要问（TC-B3-41、51、52）', () => {
  it('md：今年还没到不问；已过问“今年 / 明年”；2-29 遇平年记 2 月末并问', () => {
    expect(resolveBasis('2026-12-01', 'md', '2026-10-28')).toEqual({ ok: true, date: '2026-12-01', confirm: null });
    expect(resolveBasis('2025-05-03', 'md', '2026-10-28')).toEqual({ ok: true, date: '2026-05-03', confirm: { past: '2026-05-03', next: '2027-05-03' } });
    expect(resolveBasis('2027-02-29', 'md', '2027-01-30')).toEqual({ ok: true, date: '2027-02-28', confirm: { past: '2027-02-28', next: '2028-02-29' } });
  });

  it('d：按本月配；已过问“本月 / 下月”；本月没有这一天记月末并问', () => {
    expect(resolveBasis('2025-01-30', 'd', '2026-10-28')).toEqual({ ok: true, date: '2026-10-30', confirm: null });
    expect(resolveBasis('2026-10-03', 'd', '2026-10-28')).toEqual({ ok: true, date: '2026-10-03', confirm: { past: '2026-10-03', next: '2026-11-03' } });
    expect(resolveBasis('2026-11-31', 'd', '2026-11-05')).toEqual({ ok: true, date: '2026-11-30', confirm: { past: '2026-11-30', next: '2026-12-31' } });
  });

  it('ymd、rel 从来不问；日子不存在是 bad_date', () => {
    expect(resolveBasis('2026-10-01', 'ymd', '2026-10-28')).toEqual({ ok: true, date: '2026-10-01', confirm: null });
    expect(resolveBasis('2026-10-27', 'rel', '2026-10-28')).toEqual({ ok: true, date: '2026-10-27', confirm: null });
    expect(resolveBasis('2026-02-29', 'ymd', '2026-10-28')).toEqual({ ok: false, reason: 'bad_date' });
  });

  it('TC-B3-41：今天按请求的 now、tz 算（同一时刻首尔已是 10-31、洛杉矶还是 10-30）', () => {
    const now = Date.UTC(2026, 9, 30, 20, 0);   // 首尔 10-31 05:00，洛杉矶 10-30 13:00
    const item = { kind: 'event', date: '2026-10-30', due: null, date_basis: 'd' as const };
    const seoul = pastDate(item, now, SEOUL);
    const la = pastDate(item, now, 'America/Los_Angeles');
    expect(seoul.ok && seoul.item.confirm).toEqual({ past: '2026-10-30', next: '2026-11-30' });
    expect(la.ok && la.item.confirm).toBe(null);
  });

  it('TC-B3-51：待办按 due 判（不看 date）；有日子没 basis 是 missing_date_basis；没日子原样', () => {
    const todo = pastDate({ kind: 'todo', date: null, due: '2026-10-03', date_basis: 'd' as const }, NOW, SEOUL);
    expect(todo.ok && [todo.item.due, todo.item.confirm]).toEqual(['2026-10-03', { past: '2026-10-03', next: '2026-11-03' }]);
    expect(pastDate({ kind: 'event', date: '2026-10-30', due: null, date_basis: null }, NOW, SEOUL)).toEqual({ ok: false, reason: 'missing_date_basis' });
    const note = pastDate({ kind: 'note', date: null, due: null, date_basis: null }, NOW, SEOUL);
    expect(note.ok && note.item.confirm).toBe(null);
  });

  it('前 1 年到后 5 年', () => {
    expect([inAiRange('2025-10-28', '2026-10-28'), inAiRange('2025-10-27', '2026-10-28'), inAiRange('2031-10-28', '2026-10-28'), inAiRange('2031-10-29', '2026-10-28')])
      .toEqual([true, false, true, false]);
  });
});

describe('capture-map.ts：识别结果 → 库里的一行（M10）', () => {
  const ctx = (o: Partial<CaptureCtx> = {}): CaptureCtx => ({
    id: ID, batchId: BATCH, now: NOW, today: '2026-10-28', tz: SEOUL, source: 'page', rawText: '明天下午三点开会', origin: 'ai', ...o,
  });
  const item = (o: Partial<AiItem>): AiItem => ({ ...first(checkParseOutput({ items: [ev()] }, ALL)), ...o });

  it('日程：有时刻记 tz、提前 15 分钟提醒；过 insertSchema；AI 简称记 short_by ai，本机规则不写简称（TC-B3-05）', () => {
    const r = captureRow(item({ short: '开会' }), ctx());
    expect(r?.table).toBe('events');
    expect(insertSchema('events').safeParse(r?.row).success).toBe(true);
    const row = r?.row as unknown as Record<string, unknown>;
    expect([row['tz'], row['remind_min'], row['duration_min'], row['short'], row['short_by'], row['batch_id'], row['source']])
      .toEqual([SEOUL, 15, 60, '开会', 'ai', BATCH, 'page']);
    const rule = captureRow(item({ short: '开会' }), ctx({ origin: 'rule', source: 'chat' }))?.row as unknown as Record<string, unknown>;
    expect([rule['short'], rule['short_by'], rule['source']]).toEqual([null, null, 'chat']);
    const allDay = captureRow(item({ time: null, date: null }), ctx())?.row as unknown as Record<string, unknown>;
    expect([allDay['date'], allDay['tz'], allDay['remind_min']]).toEqual(['2026-10-28', null, null]);
    expect(insertSchema('events').safeParse(allDay).success).toBe(true);
  });

  it('TC-B3-44：待办的 time 存成 due_time、提前 60 分钟；没 due 补今天；过 insertSchema', () => {
    const r = captureRow(item({ kind: 'todo', date: null, due: null, time: '17:00' }), ctx());
    expect(r?.table).toBe('todos');
    const row = r?.row as unknown as Record<string, unknown>;
    expect([row['due'], row['due_time'], row['remind_before_min'], 'time' in row]).toEqual(['2026-10-28', '17:00', 60, false]);
    expect(insertSchema('todos').safeParse(row).success).toBe(true);
    const plain = captureRow(item({ kind: 'todo', date: null, due: null, time: null }), ctx())?.row as unknown as Record<string, unknown>;
    expect([plain['due'], plain['due_time'], plain['remind_before_min']]).toEqual([null, null, null]);
    expect(insertSchema('todos').safeParse(plain).success).toBe(true);
  });

  it('TC-B3-46：阴历纪念日一律 lunar_variant cn；阳历没有闰月；随手记 B4 才能存（null）', () => {
    const lunar = captureRow(item({ kind: 'anniv', title: '奶奶生日', anniv: { type: 'birthday', calendar: 'lunar', month: 8, day: 15, is_leap: true, year: null } }), ctx());
    expect(lunar?.table).toBe('anniversaries');
    expect(lunar?.row).toEqual({
      id: ID, kind: 'birthday', name: '奶奶生日', calendar: 'lunar', lunar_variant: 'cn', month: 8, day: 15, is_leap: true, year: null, note: '',
      created_at: NOW, updated_at: NOW,
    });
    const solar = captureRow(item({ kind: 'anniv', anniv: { type: 'anniversary', calendar: 'solar', month: 3, day: 1, is_leap: true, year: 2020 } }), ctx());
    expect((solar?.row as unknown as Record<string, unknown>)['is_leap']).toBe(false);
    expect(captureRow(item({ kind: 'anniv', anniv: null }), ctx())).toBe(null);
    expect(captureRow(item({ kind: 'note' }), ctx())).toBe(null);
  });

  it('原话截 2000 字、项目名截 40 字', () => {
    const row = captureRow(item({ project: 'p'.repeat(60) }), ctx({ rawText: '字'.repeat(2500) }))?.row as unknown as Record<string, unknown>;
    expect([(row['raw_text'] as string).length, (row['project'] as string).length]).toEqual([2000, 40]);
    expect(insertSchema('events').safeParse(row).success).toBe(true);
  });
});
