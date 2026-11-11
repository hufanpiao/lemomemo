// TC-B4b3-08：测试集 ③（tests/ai/set3）的数据自检，和本机规则 localIntent + matchTarget 跑全集的统计（不设通过线，统计钉在这里、进报告）。
// 另跑测试集 ① 的全部记下句：本机判成别的意图又有把握的必须是 0 句（D-15 不丢记录）。公共字段和 id 查重用 tests/ai/run-core.ts 的 parseSet。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { localIntent, PLUS_INTENTS, type LocalIntent } from '../../../shared/logic/parse/intent.ts';
import { confidence, parseSplit } from '../../../shared/logic/parse/index.ts';
import { matchTarget, type TargetEvent, type TargetItems, type TargetTodo } from '../../../shared/logic/parse/match-target.ts';
import { parseSet, PROJECTS, type EvalRow } from '../../ai/run-core.ts';

const BANK_NOW = Date.UTC(2026, 10, 2, 1, 0);
const SET3 = ['owner', 'zh', 'ko', 'mix'] as const;
const read = (set: string, name: string) => readFileSync(new URL(`../../ai/${set}/${name}`, import.meta.url), 'utf8');

const ROW_KEYS = new Set(['id', 'set_version', 'group', 'source', 'scored', 'text', 'now', 'tz', 'locale', 'note', 'expect', 'accept', 'fixture', 'hit', 'never', 'owner_confirmed']);
const ACCEPT_PATHS = new Set(['target.kinds', 'target.date', 'target.time', 'target.with_overdue', 'target.all', 'to.date', 'to.time', 'query.range.from', 'query.range.to', 'query.kinds', 'query.done']);
interface Expect {
  intent: (typeof PLUS_INTENTS)[number];
  query?: { range: { from: string | null; to: string }; kinds: string[]; done: string };
  target?: { kinds: string[]; date: string | null; time: string | null; with_overdue: boolean; all: boolean };
  to?: { date: string | null; time: string | null };
  items?: { kind: string; title_has: string[] }[];
}
interface Set3Row extends EvalRow {
  expect: Expect;
  accept: Record<string, unknown[]>;
  fixture?: string;
  hit?: string[];
  never?: string[];
  owner_confirmed?: boolean;
}
interface FixtureGroup {
  events: (Pick<TargetEvent, 'id' | 'title' | 'date' | 'time'> & Partial<TargetEvent>)[];
  todos: (Pick<TargetTodo, 'id' | 'title' | 'due'> & Partial<TargetTodo>)[];
}

const seen = new Set<string>();
for (const f of SET3) parseSet(`set1/${f}.jsonl`, read('set1', `${f}.jsonl`), seen);
const SET1 = [...seen];
const rows: Set3Row[] = SET3.flatMap((f) => {
  const common = parseSet(`set3/${f}.jsonl`, read('set3', `${f}.jsonl`), seen);
  const extra = read('set3', `${f}.jsonl`).split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
  return common.map((c, i) => ({ ...(extra[i] as object), ...c }) as Set3Row);
});
const fixtures = (JSON.parse(read('set3', 'fixtures.json')) as { groups: Record<string, FixtureGroup> }).groups;
const groupOf = (name: string): FixtureGroup => {
  const g = Object.entries(fixtures).find(([k]) => k === name)?.[1];
  if (!g) throw new Error(`没有样本组：${name}`);
  return g;
};
const itemsOf = (g: FixtureGroup): TargetItems => ({
  events: g.events.map((e) => ({ short: null, project: '', tz: 'Asia/Seoul', duration_min: 60, created_at: 0, location: '', ...e })),
  todos: g.todos.map((t) => ({ short: null, project: '', done: false, due_time: null, created_at: 0, ...t })),
});
/** 负责人句按原编号分语言：R01～R10 中文、R11～R20 韩文、R21～R30 混说（句库第 3 节） */
const langOf = (r: Set3Row): string => (r.group !== 'owner' ? r.group : Number(r.id.slice(1)) <= 10 ? 'zh' : Number(r.id.slice(1)) <= 20 ? 'ko' : 'mix');
const isTargetIntent = (i: string) => i === 'cancel' || i === 'reschedule' || i === 'complete';

describe('测试集 ③ 数据自检', () => {
  it('89 句：owner 17、zh 25、ko 24、mix 23；基准时间、时区、locale、版本；id 和测试集 ① 不撞', () => {
    expect(rows).toHaveLength(89);
    for (const [g, n] of [['owner', 17], ['zh', 25], ['ko', 24], ['mix', 23]] as const) expect(rows.filter((r) => r.group === g), g).toHaveLength(n);
    for (const r of rows) {
      expect(Object.keys(r).filter((k) => !ROW_KEYS.has(k)), r.id).toEqual([]);
      expect([r.now, r.tz, r.set_version, r.scored], r.id).toEqual([BANK_NOW, 'Asia/Seoul', 'set3-v0.1', 'main']);
      expect(r.locale, r.id).toBe(r.group === 'ko' ? 'ko' : 'zh');
      expect(r.owner_confirmed, r.id).toBe(r.group === 'owner' ? false : undefined);
      expect(SET1.includes(r.id), r.id).toBe(false);
      expect(Object.keys(r.accept).filter((k) => !ACCEPT_PATHS.has(k)), r.id).toEqual([]);
    }
  });
  it('期望的结构：查找有 query，取消、完成不带 to，改期带 to，记下有条目', () => {
    for (const r of rows) {
      const e = r.expect;
      expect(PLUS_INTENTS.includes(e.intent), r.id).toBe(true);
      if (e.intent === 'search') expect([typeof e.query?.done, Array.isArray(e.query?.kinds), e.target, e.to], r.id).toEqual(['string', true, undefined, undefined]);
      if (isTargetIntent(e.intent)) {
        expect(Object.keys(e.target ?? {}).sort(), r.id).toEqual(['all', 'date', 'kinds', 'time', 'with_overdue']);
        expect(e.to === undefined, r.id).toBe(e.intent !== 'reschedule');
      }
      if (e.intent === 'complete') expect(e.target?.kinds, r.id).toEqual(['todo']);
      if (e.intent === 'record') expect((e.items ?? []).every((it) => it.kind === 'todo' && it.title_has.length > 0) && (e.items ?? []).length === 1, r.id).toBe(true);
    }
  });
  it('四类和易混记下句的句数（句库第 7 节）：完成 6/5/5、批量改期 5/6/5、截止到今天 5/5/5、查冲突 5/5/5、易混记下 3/2/2', () => {
    const cat = (r: Set3Row): string => {
      const e = r.expect;
      if (e.intent === 'complete') return 'complete';
      if (e.intent === 'reschedule' && e.target?.all) return 'batch';
      if (e.intent === 'search' && e.query?.range.from === null) return 'overdue';
      if (e.intent === 'search' && e.query?.kinds.join() === 'event' && e.query.range.from === e.query.range.to) return 'conflict';
      return e.intent === 'record' ? 'record' : 'other';
    };
    const count = (c: string) => ['zh', 'ko', 'mix'].map((l) => rows.filter((r) => langOf(r) === l && cat(r) === c).length);
    expect(count('complete')).toEqual([6, 5, 5]);
    expect(count('batch')).toEqual([5, 6, 5]);
    expect(count('overdue')).toEqual([5, 5, 5]);
    expect(count('conflict')).toEqual([5, 5, 5]);
    expect(count('record')).toEqual([3, 2, 2]);
  });
  it('样本：取消、改期、完成的行都引用了样本组，hit、never 的 id 都在组里且不重叠；all 行 hit 不少于 2 条', () => {
    for (const r of rows) {
      if (!isTargetIntent(r.expect.intent)) {
        expect(r.fixture, r.id).toBe(undefined);
        continue;
      }
      const g = groupOf(r.fixture ?? '');
      const have = new Set([...g.events, ...g.todos].map((x) => x.id));
      expect([...(r.hit ?? []), ...(r.never ?? [])].filter((id) => !have.has(id)), r.id).toEqual([]);
      expect((r.hit ?? []).filter((id) => (r.never ?? []).includes(id)), r.id).toEqual([]);
      expect((r.hit ?? []).length, r.id).toBeGreaterThan(r.expect.target?.all ? 1 : 0);
    }
    const all = Object.values(fixtures).flatMap((g) => [...g.events, ...g.todos].map((x) => x.id));
    expect(all.length).toBe(new Set(all).size);
  });
});

/** 取一个字段（缺的 with_overdue、all 当 false） */
function field(r: LocalIntent, path: string): unknown {
  const t = r.target;
  switch (path) {
    case 'intent': return r.intent;
    case 'target.kinds': return t?.kinds;
    case 'target.date': return t?.date;
    case 'target.time': return t?.time;
    case 'target.with_overdue': return t ? t.with_overdue === true : undefined;
    case 'target.all': return t ? t.all === true : undefined;
    case 'to.date': return r.to?.date;
    case 'to.time': return r.to?.time;
    case 'to': return r.to;
    case 'query.range.from': return r.query?.range?.from;
    case 'query.range.to': return r.query?.range?.to;
    case 'query.kinds': return r.query?.kinds;
    case 'query.done': return r.query?.done;
    default: throw new Error(`不认的字段：${path}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 一句里没对上的字段（accept 里的值算对）；候选不对记 cands */
function misses(r: Set3Row): string[] {
  const got = localIntent(r.text, r.now, r.tz);
  const e = r.expect;
  const want: [string, unknown][] = [['intent', e.intent]];
  if (e.query) want.push(['query.range.from', e.query.range.from], ['query.range.to', e.query.range.to], ['query.kinds', e.query.kinds], ['query.done', e.query.done]);
  if (e.target) {
    for (const k of ['kinds', 'date', 'time', 'with_overdue', 'all'] as const) want.push([`target.${k}`, e.target[k]]);
    if (e.to) want.push(['to.date', e.to.date], ['to.time', e.to.time]);
    else want.push(['to', null]);
  }
  const out = want.filter(([p, v]) => !eq(field(got, p), v) && !(Object.entries(r.accept).find(([k]) => k === p)?.[1] ?? []).some((a) => eq(field(got, p), a))).map(([p]) => p);
  if (e.target) {
    const ids = got.target ? matchTarget(got.target, itemsOf(groupOf(r.fixture ?? '')), r.now, r.tz).hits.map((h) => h.id) : [];
    const hit = r.hit ?? [];
    const ok = e.target.all ? eq([...ids].sort(), [...hit].sort()) : hit.every((id) => ids.includes(id)) && !(r.never ?? []).some((id) => ids.includes(id));
    if (!ok) out.push('cands');
  }
  return out;
}

/** 判成了记下：target、to 整行都对不上，候选也没有 */
const AS_RECORD = ['intent', 'target.kinds', 'target.date', 'target.time', 'target.with_overdue', 'target.all', 'cands'];
const AS_RECORD_TO = [...AS_RECORD.slice(0, -1), 'to.date', 'to.time', 'cands'];
/**
 * 本机规则跑测试集 ③ 的统计：句子编号 → 没对上的字段（不设通过线；89 句里 26 句有缺口）。缺口分三类：
 * ① 架构 5.14 的字面句式表里没有的说法 → 判成记下（10 句，交主持人定补词还是加“疑似词判没把握”的兜底）；
 * ② 本机不从“会 / 회의 / 饭局”推断 kinds 只有 event（期望 [event]、本机 [event, todo]），批量时把含“会议”的待办也带进候选；
 * ③ 中文整句当一个关键词、韩文多了动词（“签证材料已经交了”“发票整理”“다 했어”“和 민수”），候选找不到，要交给 AI。
 */
const PINNED: Record<string, string[]> = {
  // ① 推迟到
  R06: AS_RECORD_TO, 'B-Z05': AS_RECORD_TO, 'T-Z45': AS_RECORD_TO, 'T-M45': AS_RECORD_TO,
  // ① 로 변경、변경到
  R15: AS_RECORD_TO, 'B-K03': AS_RECORD_TO, 'T-K45': AS_RECORD_TO, R25: AS_RECORD_TO,
  // ① “取消 + 宾语”“标记为 완료”
  R09: AS_RECORD, R28: AS_RECORD,
  // ②
  R05: ['target.kinds'], R19: ['target.kinds'], 'T-Z43': ['target.kinds'], 'T-K43': ['target.kinds'], 'T-K44': ['target.kinds'], 'T-M43': ['target.kinds'],
  R29: ['target.kinds', 'cands'], 'B-Z02': ['target.kinds', 'cands'], 'B-K02': ['target.kinds', 'cands'], 'B-M02': ['target.kinds', 'cands'],
  // ③
  'F-Z03': ['cands'], 'F-Z04': ['cands'], 'F-K02': ['cands'], 'F-M03': ['cands'], 'T-Z44': ['target.kinds', 'cands'], 'T-M44': ['target.kinds', 'cands'],
};
/** 第 ① 类里 localIntent 和 parseSplit 都有把握的：在线也不调 AI，会直接存成一条新条目（如待办“取消我明天下午的项目会议”） */
const SILENT = ['R09', 'R15', 'T-K45', 'T-M45'];
/** 测试集 ① 里本机判成别的意图（都没把握，先按记下保存）：R23 含“总结”、O17 含“목록” */
const SET1_UNSURE = ['R23:summarize', 'O17:search'];

describe('TC-B4b3-08：本机规则跑测试集 ③（单独统计，不设通过线）', () => {
  const table = Object.fromEntries(rows.map((r) => [r.id, misses(r)] as const).filter(([, m]) => m.length > 0));
  it('“句子 → 没对上的字段”和钉住的表完全相等', () => {
    expect(table).toEqual(PINNED);
  });
  it('易混记下句 X-Z01～03、X-K01～02、X-M01～02：本机都判记下', () => {
    const xs = rows.filter((r) => r.id.startsWith('X-'));
    expect(xs).toHaveLength(7);
    for (const r of xs) expect(localIntent(r.text, r.now, r.tz).intent, r.id).toBe('record');
  });
  it('单列：期望不是记下、本机判记下，且 localIntent 和 parseSplit 都有把握（在线也不调 AI、会直接存成新条目）', () => {
    const silent = rows
      .filter((r) => r.expect.intent !== 'record')
      .filter((r) => {
        const li = localIntent(r.text, r.now, r.tz);
        return li.intent === 'record' && li.sure && confidence(parseSplit(r.text, r.now, r.tz, r.locale, PROJECTS)) === 'sure';
      })
      .map((r) => r.id);
    expect(silent).toEqual(SILENT);
  });
});

describe('本机规则跑测试集 ① 的全部句子（全是记下句）', () => {
  const set1 = SET3.flatMap((f) => parseSet(`set1/${f}.jsonl`, read('set1', `${f}.jsonl`)));
  it('判成别的意图又有把握的：0 句', () => {
    expect(set1.filter((r) => { const li = localIntent(r.text, r.now, r.tz); return li.intent !== 'record' && li.sure; }).map((r) => r.id)).toEqual([]);
  });
  it('判成别的意图、没把握的（会先按记下保存再给查找或候选）：钉住名单', () => {
    const list = set1.map((r) => [r.id, localIntent(r.text, r.now, r.tz).intent] as const).filter(([, i]) => i !== 'record').map(([id, i]) => `${id}:${i}`);
    expect(list).toEqual(SET1_UNSURE);
  });
});
