// 测试集 ① 判分 tests/ai/score-core.ts（B3 任务单 S19；AI 句库 1.4、2.5、4.1、5.3；R-162、R-175、R-194）。
// 证明：期望逐行校验（报错带文件和行号，非空 accept 拦下）；逐字段判法（日期、时间、标题、项目、重要、confirm、basis、纪念日、short）；
// 4.1 每一项的门槛和边界（36/36/34、108、13 对 12、97% 和“编了”、拆分、规则句 18 对 17、“该问没问”、重复说法、不比上一次差）；
// 句库和结果对不上时结论是“未定”；摘要和判分结果里不出现句子原文、模型原文。
import { describe, expect, it } from 'vitest';
import {
  GATE, judgeItem, judgeRow, normTitle, parseExpect, rawHasRepeat, scoreRun, toMarkdown,
  type Baseline, type ExpItem, type RunReport, type RunResult, type SetRow,
} from '../ai/score-core.ts';

const V = 'set1-v1.6';
const ev = (o: Partial<ExpItem> = {}): ExpItem => ({
  kind: 'event', date: '2026-11-03', time: '15:00', title_has: ['开会'], title_forbid: ['明天'], project: null, important: false, confirm: null, ...o,
});
/** 和 ev() 一致的一条校验后结果 */
const okItem = (o: Record<string, unknown> = {}) => ({
  kind: 'event', title: '和客户开会', date: '2026-11-03', time: '15:00', duration_min: null, due: null, important: false, project: null,
  body: null, short: null, date_basis: 'rel', anniv: null, confirm: null, ...o,
});
const row = (id: string, group: string, scored: SetRow['scored'] = 'main', expect: ExpItem[] = [ev()]): SetRow =>
  ({ id, set_version: V, group, scored, expect, expect_invalid_date: false, title_ignore_person: false, owner_confirmed: group === 'owner' });
const res = (id: string, items: Record<string, unknown>[] = [okItem()], o: Partial<RunResult> = {}): RunResult =>
  ({ id, ok: true, reason: null, raw: { items }, checked: { items }, invalid_reasons: null, ...o });

/** 照 4.1 分母造一整套：三组各 40 句、负责人 13 句、规则句 18 句、观察句 2 句；默认全对 */
function fullSet(): SetRow[] {
  const rows: SetRow[] = [];
  for (const [g, p] of [['zh', 'Z'], ['ko', 'K'], ['mix', 'M']] as const) {
    // 多件事的句子：Z01～Z05、K01～K04、M01～M04 共 13 句（句库 4.1 拆分一行；真句库加负责人 R30 是 14 句）
    const multi = g === 'zh' ? 5 : 4;
    for (let i = 1; i <= 40; i++) rows.push(row(`${p}${String(i).padStart(2, '0')}`, g, 'main', i <= multi ? [ev(), ev({ title_has: ['看牙'] })] : [ev()]));
    for (let i = 41; i <= 46; i++) rows.push(row(`${p}${i}`, g, 'rule'));
  }
  // 负责人 R01 也是多件事（真句库是 R30），合计 14 句
  for (let i = 1; i <= 13; i++) rows.push(row(`R${String(i).padStart(2, '0')}`, 'owner', 'main', i === 1 ? [ev(), ev({ title_has: ['看牙'] })] : [ev()]));
  rows.push(row('O01', 'mix', 'observe'), row('O02', 'zh', 'observe'));
  return rows;
}
const runOf = (rows: SetRow[], patch: Record<string, RunResult | null> = {}): RunReport => {
  const results: RunResult[] = [];
  const skipped: string[] = [];
  for (const r of rows) {
    const p = patch[r.id];
    if (p === null) skipped.push(r.id);
    else results.push(p ?? res(r.id, r.expect.map((e) => okItem({ title: (e.title_has ?? []).join('') }))));
  }
  return { meta: { name: 'set1-2026-11-20-parse.v1-gemini-3.5-flash-lite', set_versions: [V], total: rows.length }, results, skipped, stopped: skipped.length ? 'daily_cap' : null };
};
const check = (s: ReturnType<typeof scoreRun>, key: string) => {
  const c = s.checks.find((x) => x.key === key);
  if (!c) throw new Error(`没有 ${key}`);
  return c;
};
/** 让一句错：标题不含须含的词（下面要卡边界的都挑单件事的句子，免得连带拆分一项） */
const wrong = (id: string) => res(id, [okItem({ title: '别的' })]);

describe('parseExpect：读期望', () => {
  const line = (o: Record<string, unknown> = {}) => JSON.stringify({ id: 'Z01', set_version: V, group: 'zh', scored: 'main', text: 'x', expect: [ev()], accept: {}, ...o });
  it('合格的读出来，空行跳过，expect_invalid_date 默认 false', () => {
    const rows = parseExpect('zh.jsonl', `${line()}\n\n${line({ id: 'O05', scored: 'observe', expect_invalid_date: true })}\r\n`);
    expect(rows.map((r) => [r.id, r.scored, r.expect_invalid_date])).toEqual([['Z01', 'main', false], ['O05', 'observe', true]]);
  });
  it('报错带文件名和行号', () => {
    expect(() => parseExpect('zh.jsonl', `${line()}\n{坏`)).toThrow('zh.jsonl:2 不是 JSON');
    expect(() => parseExpect('ko.jsonl', line({ scored: 'x' }))).toThrow('ko.jsonl:1 字段 scored');
    expect(() => parseExpect('zh.jsonl', line({ expect: [{ kind: 'meeting' }] }))).toThrow('expect[0].kind');
    expect(() => parseExpect('zh.jsonl', line({ expect: [ev({ title_has: 'a' as unknown as string[] })] }))).toThrow('title_has');
    expect(() => parseExpect('zh.jsonl', line({ expect: [{ kind: 'anniv', anniv: { type: 'birthday', calendar: 'solar', month: 3 } }] }))).toThrow('anniv');
  });
  it('accept 不是空的就停（判法没定，不悄悄当成没有）', () => {
    expect(() => parseExpect('zh.jsonl', line({ accept: { kind: ['todo'] } }))).toThrow('accept 不是空的');
  });
});

describe('judgeItem：逐字段（句库 1.4）', () => {
  const main = { scored: 'main' as const };
  it('全对', () => expect(judgeItem(ev(), okItem(), main).wrong).toEqual([]));
  it('日程看 date、待办看 due；期望为空却给了日子算“编了”', () => {
    expect(judgeItem(ev(), okItem({ date: '2026-11-04' }), main).wrong).toEqual(['date']);
    const t = judgeItem(ev({ kind: 'todo', due: null, time: null }), okItem({ kind: 'todo', due: '2026-11-02', date: null, time: null }), main);
    expect(t.wrong).toEqual(['date']);
    expect(t.date).toEqual({ on: true, ok: false, madeUp: true });
  });
  it('时间相差 0 分钟（9:00 和 09:00 一样）；期望为空却给了时刻算“编了”', () => {
    expect(judgeItem(ev({ time: '09:00' }), okItem({ time: '9:00' }), main).wrong).toEqual([]);
    const j = judgeItem(ev({ time: null }), okItem({ time: '19:00' }), main);
    expect(j.wrong).toEqual(['time']);
    expect(j.time.madeUp).toBe(true);
  });
  it('标题：去空格、全角半角、不分大小写；不许含的词也按同样规整比', () => {
    expect(judgeItem(ev({ title_has: ['NEOX 报价单'] }), okItem({ title: 'ｎｅｏｘ报价单' }), main).wrong).toEqual([]);
    expect(judgeItem(ev(), okItem({ title: '明 天开会' }), main).wrong).toEqual(['title_forbid']);
    expect(normTitle('박 대리')).toBe(normTitle('박대리'));
  });
  it('随手记：须含的词在正文里也算；不评日期、项目；short 必须为空', () => {
    const e: ExpItem = { kind: 'note', title_has: ['灵感'], important: false };
    const a = { kind: 'note', title: '', body: '一个灵感', project: 'NEOX', short: null, date: null, due: null, time: null };
    expect(judgeItem(e, a, main).wrong).toEqual([]);
    expect(judgeItem(e, { ...a, short: '灵' }, main).wrong).toEqual(['short']);
  });
  it('项目不许编；重要必须一致', () => {
    expect(judgeItem(ev(), okItem({ project: 'NEOX' }), main).wrong).toEqual(['project']);
    expect(judgeItem(ev({ important: true }), okItem(), main).wrong).toEqual(['important']);
  });
  it('confirm：要问的 past、next 都对；不该问的必须不带', () => {
    const c = { past: '2026-10-30', next: '2027-10-30' };
    expect(judgeItem(ev({ confirm: c }), okItem({ confirm: c }), main).wrong).toEqual([]);
    expect(judgeItem(ev({ confirm: c }), okItem({ confirm: { ...c, next: '2026-10-31' } }), main).wrong).toEqual(['confirm']);
    expect(judgeItem(ev(), okItem({ confirm: c }), main).wrong).toEqual(['confirm']);
  });
  it('basis：规则句算错；计分句只记录、不进对错', () => {
    expect(judgeItem(ev({ date_basis: 'md' }), okItem(), { scored: 'rule' }).wrong).toEqual(['date_basis']);
    const m = judgeItem(ev({ date_basis: 'md' }), okItem(), main);
    expect(m.wrong).toEqual([]);
    expect(m.basis).toBe(false);
  });
  it('纪念日：六个字段都对；月日或阴阳历错同时算日期错', () => {
    const an = { type: 'birthday', calendar: 'lunar', month: 8, day: 15, is_leap: false, year: null };
    const e: ExpItem = { kind: 'anniv', anniv: an, title_has: ['妈妈'], important: false, project: null };
    const a = { kind: 'anniv', title: '妈妈生日', anniv: an, project: null, short: null };
    expect(judgeItem(e, a, main).wrong).toEqual([]);
    expect(judgeItem(e, { ...a, anniv: { ...an, year: 1960 } }, main).wrong).toEqual(['anniv']);
    const d = judgeItem(e, { ...a, anniv: { ...an, calendar: 'solar' } }, main);
    expect(d.wrong).toEqual(['date', 'anniv']);
  });
  it('日程、待办的 short 超过 2 个字形簇算错（\u{1F468}\u200d\u{1F469}\u200d\u{1F467} 是 1 个）', () => {
    expect(judgeItem(ev(), okItem({ short: '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}' }), main).wrong).toEqual([]);
    expect(judgeItem(ev(), okItem({ short: '开会了' }), main).wrong).toEqual(['short']);
  });
  it('说了时长的才评时长', () => {
    expect(judgeItem(ev({ duration_min: 120 }), okItem({ duration_min: 60 }), main).wrong).toEqual(['duration_min']);
    expect(judgeItem(ev(), okItem({ duration_min: 60 }), main).wrong).toEqual([]);
  });
});

describe('judgeRow：整句', () => {
  it('整份退回按错算，原因带 invalid_reasons；没跑到按 missing', () => {
    const j = judgeRow(row('Z01', 'zh'), res('Z01', [], { ok: false, reason: 'invalid', checked: null, invalid_reasons: ['missing_date_basis'] }));
    expect([j.status, j.why]).toEqual(['wrong', ['invalid', 'missing_date_basis']]);
    expect(j.items[0]?.date).toEqual({ on: true, ok: false, madeUp: false });
    expect(judgeRow(row('Z01', 'zh'), undefined).status).toBe('missing');
  });
  it('条数不对算错；单件事拆成两条记 split', () => {
    const j = judgeRow(row('Z01', 'zh'), res('Z01', [okItem(), okItem()]));
    expect([j.status, j.why, j.split]).toEqual(['wrong', ['count'], true]);
  });
  it('该问没问：校验通过、期望带 confirm、结果没带', () => {
    const c = { past: '2026-10-30', next: '2027-10-30' };
    expect(judgeRow(row('Z43', 'zh', 'rule', [ev({ confirm: c })]), res('Z43')).unasked).toBe(true);
    // 整份退回的只算这一句错，不算该问没问（0.29 续第 72 条）
    expect(judgeRow(row('Z43', 'zh', 'rule', [ev({ confirm: c })]), res('Z43', [], { ok: false, reason: 'invalid', checked: null })).unasked).toBe(false);
  });
  it('重复说法：原始输出带 rrule 一类的键，或拆成多条', () => {
    expect(rawHasRepeat({ items: [{ kind: 'event', Recurrence: 'weekly' }] })).toBe(true);
    expect(rawHasRepeat({ items: [{ kind: 'event', title: '每周一例会' }] })).toBe(false);
    expect(judgeRow(row('Z41', 'zh', 'rule'), res('Z41', [okItem()], { raw: { items: [{ ...okItem(), repeat: 'weekly' }] } })).repeatBad).toBe(true);
    expect(judgeRow(row('Z41', 'zh', 'rule'), res('Z41', [okItem(), okItem()])).repeatBad).toBe(true);
    expect(judgeRow(row('Z01', 'zh'), res('Z01', [okItem(), okItem()])).repeatBad).toBe(false);
  });
});

describe('scoreRun：4.1 每一项', () => {
  it('全对：通过；B 路和 intent 只列出来、不进结论', () => {
    const rows = fullSet();
    const s = scoreRun(rows, runOf(rows));
    expect(s.verdict).toBe('pass');
    expect(s.problems).toEqual([]);
    expect(check(s, 'local').status).toBe('na');
    expect(check(s, 'intent').status).toBe('na');
    expect(check(s, 'regress').status).toBe('na');
  });
  it('中文组 36 过、35 不过；混说组 34 过、33 不过；整体要三组各自过线', () => {
    const rows = fullSet();
    const bad = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, wrong(id)]));
    const s36 = scoreRun(rows, runOf(rows, bad(['Z10', 'Z11', 'Z12', 'Z13'])));
    expect([check(s36, 'group_zh').status, s36.verdict]).toEqual(['pass', 'pass']);
    const s35 = scoreRun(rows, runOf(rows, bad(['Z10', 'Z11', 'Z12', 'Z13', 'Z14'])));
    expect([check(s35, 'group_zh').status, check(s35, 'total').status, s35.verdict]).toEqual(['fail', 'fail', 'fail']);
    expect(check(s35, 'group_zh').ids).toEqual(['Z10', 'Z11', 'Z12', 'Z13', 'Z14']);
    const m34 = scoreRun(rows, runOf(rows, bad(['M10', 'M11', 'M12', 'M13', 'M14', 'M15'])));
    expect(check(m34, 'group_mix').status).toBe('pass');
    const m33 = scoreRun(rows, runOf(rows, bad(['M10', 'M11', 'M12', 'M13', 'M14', 'M15', 'M16'])));
    expect(check(m33, 'group_mix').status).toBe('fail');
  });
  it('整体 108：三组各错 4 句（36+36+36）过；再错一句混说也还过线，但整体 107 不过', () => {
    const rows = fullSet();
    const ids = ['Z10', 'Z11', 'Z12', 'Z13', 'K10', 'K11', 'K12', 'K13', 'M10', 'M11', 'M12', 'M13'];
    const ok = scoreRun(rows, runOf(rows, Object.fromEntries(ids.map((id) => [id, wrong(id)]))));
    expect(check(ok, 'total').got).toBe('108/120');
    expect(check(ok, 'total').status).toBe('pass');
    const no = scoreRun(rows, runOf(rows, Object.fromEntries([...ids, 'M14'].map((id) => [id, wrong(id)]))));
    expect([check(no, 'group_mix').status, check(no, 'total').status]).toEqual(['pass', 'fail']);
  });
  it('负责人句 13 对 12 过、对 11 不过', () => {
    const rows = fullSet();
    expect(check(scoreRun(rows, runOf(rows, { R01: wrong('R01') })), 'owner').status).toBe('pass');
    expect(check(scoreRun(rows, runOf(rows, { R01: wrong('R01'), R02: wrong('R02') })), 'owner').status).toBe('fail');
  });
  it('日期：编了 1 条就不过；时间：编了 1 条还过、2 条不过', () => {
    const rows = fullSet();
    rows[0] = row('Z01', 'zh', 'main', [ev({ date: null, time: null })]);
    rows[1] = row('Z02', 'zh', 'main', [ev({ time: null })]);
    const madeDate = scoreRun(rows, runOf(rows, { Z01: res('Z01', [okItem({ time: null })]) }));
    expect(check(madeDate, 'date').status).toBe('fail');
    expect(check(madeDate, 'date').ids).toEqual(['Z01']);
    const t1 = scoreRun(rows, runOf(rows, { Z01: res('Z01', [okItem({ date: null, time: null })]), Z02: res('Z02', [okItem({ time: '19:00' })]) }));
    expect(check(t1, 'time').status).toBe('pass');
    const t2 = scoreRun(rows, runOf(rows, { Z01: res('Z01', [okItem({ date: null, time: '19:00' })]), Z02: res('Z02', [okItem({ time: '19:00' })]) }));
    expect(check(t2, 'time').status).toBe('fail');
  });
  it('日期 97%：按条目算，分母 147 条（三组 120 句 + 负责人 13 句，多件事 14 句各多一条；不含规则句、观察句），错 4 条（97.3%）过，错 5 条（96.6%）不过', () => {
    const rows = fullSet();
    const bad = (n: number) => Object.fromEntries(['Z10', 'K10', 'M10', 'R02', 'Z11'].slice(0, n).map((id) => [id, res(id, [okItem({ date: '2026-11-09' })])]));
    expect(check(scoreRun(rows, runOf(rows, bad(4))), 'date').got).toBe('143/147（97.3%），编了 0 条');
    expect(check(scoreRun(rows, runOf(rows, bad(4))), 'date').status).toBe('pass');
    expect(check(scoreRun(rows, runOf(rows, bad(5))), 'date').status).toBe('fail');
    // 规则句的日期错不进这一项
    expect(check(scoreRun(rows, runOf(rows, { ...bad(4), Z43: res('Z43', [okItem({ date: '2026-11-09' })]) })), 'date').status).toBe('pass');
  });
  it('拆分：多件事 14 句条数全对至少 12 句；单件事拆开最多 2 句', () => {
    const rows = fullSet();
    const one = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, res(id, [okItem()])]));
    expect(check(scoreRun(rows, runOf(rows, one(['Z01', 'K01']))), 'split').got).toBe('多件事条数全对 12/14，单件事拆成多条 0 句');
    expect(check(scoreRun(rows, runOf(rows, one(['Z01', 'K01']))), 'split').status).toBe('pass');
    expect(check(scoreRun(rows, runOf(rows, one(['Z01', 'K01', 'M01']))), 'split').status).toBe('fail');
    const split = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, res(id, [okItem(), okItem()])]));
    expect(check(scoreRun(rows, runOf(rows, split(['K10', 'K11']))), 'split').status).toBe('pass');
    expect(check(scoreRun(rows, runOf(rows, split(['K10', 'K11', 'K12']))), 'split').status).toBe('fail');
  });
  it('规则句：18 对 17 过、对 16 不过；该问没问、重复说法各 1 条就不过', () => {
    const rows = fullSet();
    expect(check(scoreRun(rows, runOf(rows, { Z44: wrong('Z44') })), 'rule').status).toBe('pass');
    expect(check(scoreRun(rows, runOf(rows, { Z44: wrong('Z44'), K44: wrong('K44') })), 'rule').status).toBe('fail');
    const c = { past: '2026-10-30', next: '2027-10-30' };
    const i = rows.findIndex((r) => r.id === 'Z43');
    rows[i] = row('Z43', 'zh', 'rule', [ev({ confirm: c })]);
    const s = scoreRun(rows, runOf(rows, { Z43: res('Z43') }));
    expect([check(s, 'rule').status, check(s, 'rule').ids]).toEqual(['fail', ['Z43']]);
    const r2 = fullSet();
    const rep = scoreRun(r2, runOf(r2, { M41: res('M41', [okItem()], { raw: { items: [{ ...okItem(), rrule: 'FREQ=WEEKLY' }] } }) }));
    expect(check(rep, 'rule').status).toBe('fail');
  });
  it('观察句错了不影响任何一项', () => {
    const rows = fullSet();
    const s = scoreRun(rows, runOf(rows, { O01: wrong('O01'), O02: res('O02', [], { ok: false, reason: 'invalid', checked: null, invalid_reasons: ['bad_date'] }) }));
    expect(s.verdict).toBe('pass');
    expect((s.stats['observe'] as { id: string }[]).map((x) => x.id)).toEqual(['O01', 'O02']);
  });
});

describe('scoreRun：对不上就“未定”，不凑成通过', () => {
  it('有句子没跑到（每天上限停下）', () => {
    const rows = fullSet();
    const s = scoreRun(rows, runOf(rows, { R13: null }));
    expect(s.verdict).toBe('undecided');
    expect(s.problems.join()).toContain('1 句没跑到（daily_cap）：R13');
  });
  it('分母不是 40 / 13 / 18', () => {
    const rows = fullSet().filter((r) => r.id !== 'K40' && r.id !== 'R13' && r.id !== 'M46');
    const s = scoreRun(rows, runOf(rows));
    expect(s.verdict).toBe('undecided');
    expect(s.problems).toEqual(['ko 组计分句是 39 句，不是 40 句', '负责人计分句是 12 句，不是 13 句', '规则句是 17 句，不是 18 句']);
  });
  it('结果的句库版本和现在的句库不一样、结果里有句库没有的句子', () => {
    const rows = fullSet();
    const run = runOf(rows);
    run.meta.set_versions = ['set1-v1.5'];
    run.results.push(res('Z99'));
    expect(scoreRun(rows, run).problems).toEqual(['结果的句库版本 set1-v1.5 和现在的句库 set1-v1.6 不一样', '结果里有句库没有的句子：Z99']);
  });
});

describe('不比上一次差（按句子比，补跑 3 次分稳定错 / 偶尔错）', () => {
  const rows = fullSet();
  const base: Baseline = { set_versions: [V], rows: rows.map((r) => ({ id: r.id, status: 'ok' })) };
  const first = runOf(rows, { Z10: wrong('Z10'), K10: wrong('K10'), M10: wrong('M10') });
  const retry = (ids: string[], okIds: string[] = []): RunReport => ({ ...runOf([]), results: ids.map((id) => (okIds.includes(id) ? res(id) : wrong(id))) });
  it('3 句都补跑了 3 次、都错：不通过', () => {
    const s = scoreRun(rows, first, { baseline: base, retries: [retry(['Z10', 'K10', 'M10']), retry(['Z10', 'K10', 'M10']), retry(['Z10', 'K10', 'M10'])] });
    expect([check(s, 'regress').status, check(s, 'regress').ids, s.verdict]).toEqual(['fail', ['Z10', 'K10', 'M10'], 'fail']);
  });
  it('其中一句补跑对了一次（偶尔错）：只剩 2 句稳定错，过', () => {
    const s = scoreRun(rows, first, { baseline: base, retries: [retry(['Z10', 'K10', 'M10'], ['M10']), retry(['Z10', 'K10', 'M10']), retry(['Z10', 'K10', 'M10'])] });
    expect(check(s, 'regress').status).toBe('pass');
    expect(s.verdict).toBe('pass');
  });
  it('补跑不够 3 次、可能达到 3 句：未定', () => {
    const s = scoreRun(rows, first, { baseline: base, retries: [retry(['Z10', 'K10', 'M10'])] });
    expect([check(s, 'regress').status, s.verdict]).toEqual(['pending', 'undecided']);
  });
  it('基线句库版本不同：未定（要用新句库重跑旧版本定新基线）', () => {
    const s = scoreRun(rows, runOf(rows), { baseline: { ...base, set_versions: ['set1-v1.5'] } });
    expect(check(s, 'regress').status).toBe('pending');
  });
  it('观察句不算；上次就错的不算', () => {
    const b2: Baseline = { set_versions: [V], rows: base.rows.map((r) => (r.id === 'Z01' ? { ...r, status: 'wrong' } : r)) };
    const s = scoreRun(rows, runOf(rows, { Z01: wrong('Z01'), O01: wrong('O01') }), { baseline: b2 });
    expect(check(s, 'regress').got).toBe('上次对这次错 0 句，其中稳定错 0 句');
  });
});

describe('统计和摘要', () => {
  it('缺 date_basis 整份退回的比例：分母排除没拿到输出的，观察句单列', () => {
    const rows = fullSet();
    const s = scoreRun(rows, runOf(rows, {
      Z01: res('Z01', [], { ok: false, reason: 'invalid', checked: null, invalid_reasons: ['missing_date_basis'] }),
      Z02: res('Z02', [], { ok: false, reason: 'quota', raw: null, checked: null }),
      O01: res('O01', [], { ok: false, reason: 'invalid', checked: null, invalid_reasons: ['missing_date_basis'] }),
    }));
    const m = s.stats['missing_date_basis'] as Record<string, string>;
    expect(m['zh']).toBe('1/45（2.2%）');
    expect(m['观察句']).toBe('1/2（50.0%）');
    expect(s.stats['invalid_reasons']).toEqual({ missing_date_basis: 2, quota: 1 });
  });
  it('摘要和判分结果里没有句子原文、模型原文', () => {
    const rows = fullSet();
    const secret = '和小王在江南站见面';
    const s = scoreRun(rows, runOf(rows, { Z10: res('Z10', [okItem({ title: secret })]) }));
    expect(JSON.stringify(s)).not.toContain(secret);
    const md = toMarkdown(s);
    expect(md).not.toContain(secret);
    expect(md).toContain('| Z10 | zh | main | — | title_has |');
    // 错 1 句，中文组 39/40 仍过线
    expect(md).toContain('结论（A 路门槛，只按第一遍）：**通过**');
  });
  it('门槛数字照 4.1', () => {
    expect([GATE.group.zh, GATE.group.ko, GATE.group.mix, GATE.total, GATE.ruleOk, GATE.multiOkMin, GATE.singleSplitMax]).toEqual([36, 36, 34, 108, 17, 12, 2]);
  });
});

describe('代码审返工：期望白名单、没拿到输出、观察句、负责人确认、REPEAT_IDS、补跑标注', () => {
  const line = (o: Record<string, unknown> = {}) => JSON.stringify({ id: 'Z01', set_version: V, group: 'zh', scored: 'main', text: 'x', expect: [ev()], accept: {}, ...o });
  it('不认的键一律报错：顶层、条目、纪念日；short 只许 null；布尔字段要是布尔', () => {
    expect(() => parseExpect('zh.jsonl', line({ expected: [] }))).toThrow('zh.jsonl:1 不认的键：expected');
    expect(() => parseExpect('zh.jsonl', line({ expect: [{ ...ev(), titel_has: ['x'] }] }))).toThrow('expect[0] 不认的键：titel_has');
    const an = { type: 'birthday', calendar: 'solar', month: 3, day: 1, is_leap: false, year: null };
    expect(() => parseExpect('zh.jsonl', line({ expect: [{ kind: 'anniv', anniv: { ...an, lunar_variant: 'cn' } }] }))).toThrow('expect[0].anniv');
    expect(() => parseExpect('zh.jsonl', line({ expect: [{ kind: 'note', short: '记' }] }))).toThrow('expect[0].short');
    expect(() => parseExpect('zh.jsonl', line({ owner_confirmed: 'yes' }))).toThrow('字段 owner_confirmed');
  });
  it('计分句、规则句的日程、待办缺日子、time、confirm 就停；观察句可以不写 time（时间不评）', () => {
    const { time: _t, ...noTime } = ev();
    expect(() => parseExpect('zh.jsonl', line({ expect: [noTime] }))).toThrow('expect[0].time');
    expect(() => parseExpect('zh.jsonl', line({ scored: 'rule', expect: [{ ...ev(), confirm: undefined }] }))).toThrow('expect[0].confirm');
    expect(() => parseExpect('zh.jsonl', line({ expect: [{ kind: 'todo', time: null, confirm: null }] }))).toThrow('expect[0].due');
    const o = parseExpect('zh.jsonl', line({ id: 'O05', scored: 'observe', expect: [noTime] }));
    expect(judgeItem(o[0]?.expect[0] as ExpItem, okItem({ time: '09:30' }), { scored: 'observe' }).wrong).toEqual([]);
  });
  it('title_ignore_person：读出来；人名写成什么样标题一项都不管（须含只列事由）', () => {
    const [m] = parseExpect('mix.jsonl', line({ id: 'M31', group: 'mix', title_ignore_person: true, expect: [ev({ title_forbid: ['明天', '下午三点'] })] }));
    expect(m?.title_ignore_person).toBe(true);
    expect(judgeRow(m as SetRow, res('M31', [okItem({ title: '和帕大力开会' })])).status).toBe('ok');
    expect(judgeRow(m as SetRow, res('M31', [okItem({ title: '和박 대리开会' })])).status).toBe('ok');
  });
  it('quota、timeout、error 不算答错：记进 problems、结论未定；invalid 照算错', () => {
    const rows = fullSet();
    const s = scoreRun(rows, runOf(rows, {
      Z10: res('Z10', [], { ok: false, reason: 'timeout', raw: null, checked: null }),
      K10: res('K10', [], { ok: false, reason: 'invalid', checked: null, invalid_reasons: ['schema'] }),
      O01: res('O01', [], { ok: false, reason: 'quota', raw: null, checked: null }),
    }));
    expect(s.rows.find((r) => r.id === 'Z10')?.status).toBe('nooutput');
    expect(s.rows.find((r) => r.id === 'K10')?.status).toBe('wrong');
    expect(s.problems).toEqual(['1 句没拿到模型输出（不算答错，要重跑）：Z10（timeout）']);
    expect(s.verdict).toBe('undecided');
    expect(toMarkdown(s)).toContain('| Z10 | zh | main | 没拿到输出：timeout |');
  });
  it('月份本来没有的观察句：bad_date 整份退回算符合预期，收下了算和预期不同；摘要不说“错”', () => {
    const rows = fullSet();
    rows.push({ ...row('O05', 'zh', 'observe', [{ kind: 'event', date: null, project: null, important: false, confirm: null }]), expect_invalid_date: true });
    const rejected = scoreRun(rows, runOf(rows, { O05: res('O05', [], { ok: false, reason: 'invalid', checked: null, invalid_reasons: ['bad_date'] }) }));
    expect(rejected.rows.find((r) => r.id === 'O05')?.status).toBe('ok');
    expect(toMarkdown(rejected)).toContain('| O05 | zh | 符合预期 | invalid、bad_date |');
    expect(rejected.verdict).toBe('pass');
    const kept = scoreRun(rows, runOf(rows, { O05: res('O05', [okItem({ date: null, time: '15:00' })]) }));
    expect(kept.rows.find((r) => r.id === 'O05')?.why).toEqual(['not_rejected']);
    expect(toMarkdown(kept)).toContain('| O05 | zh | 和预期不同 | not_rejected |');
    expect(toMarkdown(kept)).not.toMatch(/\| O05 \| zh \| observe/);
    expect(kept.verdict).toBe('pass');
  });
  it('负责人句有一句没确认（owner_confirmed 不是 true）：这一项未定，结论未定，写明是哪几句', () => {
    const rows = fullSet().map((r) => (r.id === 'R05' || r.id === 'R09' ? { ...r, owner_confirmed: false } : r));
    const s = scoreRun(rows, runOf(rows));
    expect(check(s, 'owner').status).toBe('pending');
    expect(check(s, 'owner').got).toContain('2 句负责人还没确认期望（owner_confirmed 不是 true），确认后才计分：R05、R09');
    expect(s.verdict).toBe('undecided');
  });
  it('REPEAT_IDS 有一个不在规则句里、多件事不是 14 句：记进 problems', () => {
    const rows = fullSet().map((r) => (r.id === 'K42' ? { ...r, scored: 'main' as const } : r));
    expect(scoreRun(rows, runOf(rows)).problems).toContain('重复说法的句子不在规则句里：K42（句库改了编号要同步 REPEAT_IDS）');
    const r2 = fullSet().map((r) => (r.id === 'R01' ? row('R01', 'owner') : r));
    expect(scoreRun(r2, runOf(r2)).problems).toEqual(['多件事的句子是 13 句，不是 14 句（13 句加负责人 R30，句库 4.1）']);
  });
  it('补跑：第一遍错的句子标稳定错 / 偶尔错 / 未定；没拿到输出的那次补跑不算数', () => {
    const rows = fullSet();
    const first = runOf(rows, { Z10: wrong('Z10'), K10: wrong('K10'), M10: wrong('M10') });
    const retry = (results: RunResult[]): RunReport => ({ ...runOf([]), results });
    const to = res('M10', [], { ok: false, reason: 'timeout', raw: null, checked: null });
    const s = scoreRun(rows, first, {
      retries: [retry([wrong('Z10'), wrong('K10'), to]), retry([wrong('Z10'), res('K10'), wrong('M10')]), retry([wrong('Z10'), wrong('K10'), wrong('M10')])],
    });
    const of = (id: string) => s.rows.find((r) => r.id === id);
    expect([of('Z10')?.stability, of('K10')?.stability, of('M10')?.stability]).toEqual(['stable', 'flaky', 'unknown']);
    expect(of('M10')?.retries).toEqual({ tries: 2, wrong: 2 });
    const md = toMarkdown(s);
    expect(md).toContain('| 稳定错（补跑 3 次错 3 次） |');
    expect(md).toContain('| 偶尔错（补跑 3 次错 2 次） |');
    expect(md).toContain('| 未定（补跑 2 次错 2 次） |');
    expect(md).toContain('整份退回（invalid）的句子，这句的条目在日期、时间两项的分母里都按错算');
    // 没传补跑：标“没补跑”
    expect(toMarkdown(scoreRun(rows, first))).toContain('| 未定（没补跑） |');
  });
});

describe('代码审复查建议：补跑要和第一遍同一模型、提示词、句库；没拿到输出的句子让判定栏未定、不显示没过', () => {
  const noOut = (id: string) => res(id, [], { ok: false, reason: 'timeout', raw: null, checked: null });
  const badDate = (id: string) => res(id, [okItem({ title: '开会', date: '2026-11-04' })]);
  const meta = (r: RunReport, o: Partial<RunReport['meta']>): RunReport => ({ ...r, meta: { ...r.meta, ...o } });
  it('补跑的模型或提示词和第一遍不一样：那份补跑不算数、记进 problems；一样的照常计', () => {
    const rows = fullSet();
    const first = meta(runOf(rows, { Z10: wrong('Z10') }), { model: 'gemini-3.5-flash-lite', prompt: 'parse.v1' });
    const retry = (o: Partial<RunReport['meta']>): RunReport => meta({ ...runOf([]), results: [wrong('Z10')] }, { name: 'only-x', model: 'gemini-3.5-flash-lite', prompt: 'parse.v1', ...o });
    const ok3 = scoreRun(rows, first, { retries: [retry({}), retry({}), retry({})] });
    expect(ok3.problems).toEqual([]);
    expect(ok3.rows.find((r) => r.id === 'Z10')?.stability).toBe('stable');
    const s = scoreRun(rows, first, { retries: [retry({}), retry({ model: 'gemini-9' }), retry({ prompt: 'parse.v2', name: 'only-y' }), retry({ set_versions: ['set1-v9'], name: 'only-z' })] });
    expect(s.problems).toEqual(['补跑结果和第一遍的模型、提示词或句库版本不一样，这几份补跑不算数：only-x（gemini-9、parse.v1、set1-v1.6）；only-y（gemini-3.5-flash-lite、parse.v2、set1-v1.6）；only-z（gemini-3.5-flash-lite、parse.v1、set1-v9）']);
    expect(s.rows.find((r) => r.id === 'Z10')?.retries).toEqual({ tries: 1, wrong: 1 });
    expect(s.rows.find((r) => r.id === 'Z10')?.stability).toBe('unknown');
    expect(s.verdict).toBe('undecided');
  });
  it('组：没拿到输出的全算对能过线就是未定；全算对也不够才是没过', () => {
    const rows = fullSet();
    const pend = scoreRun(rows, runOf(rows, { Z20: wrong('Z20'), Z21: wrong('Z21'), Z22: wrong('Z22'), Z23: noOut('Z23'), Z24: noOut('Z24') }));
    expect(check(pend, 'group_zh')).toMatchObject({ status: 'pending', got: '35/40；另有 2 句没拿到输出，对错未知' });
    expect(check(pend, 'total').status).toBe('pending');
    const fail = scoreRun(rows, runOf(rows, { Z20: wrong('Z20'), Z21: wrong('Z21'), Z22: wrong('Z22'), Z23: wrong('Z23'), Z24: wrong('Z24'), Z25: noOut('Z25') }));
    expect(check(fail, 'group_zh').status).toBe('fail');
    expect(check(fail, 'total').status).toBe('fail');
    // 只有一句没拿到输出，其余全对：组仍然确定过线
    expect(check(scoreRun(rows, runOf(rows, { Z20: noOut('Z20') })), 'group_zh').status).toBe('pass');
  });
  it('日期：没拿到输出的条目算对也够 97% 是未定（不显示没过）；算对也不够才没过；全对只差一条没输出也是未定', () => {
    const rows = fullSet();
    const four = { Z20: badDate('Z20'), Z21: badDate('Z21'), K20: badDate('K20'), M20: badDate('M20') };
    const pend = scoreRun(rows, runOf(rows, { ...four, M21: noOut('M21') }));
    expect(check(pend, 'date')).toMatchObject({ status: 'pending', got: '142/147（96.6%），编了 0 条；另有 1 条没拿到输出，对错未知' });
    expect(check(scoreRun(rows, runOf(rows, { ...four, K21: badDate('K21'), M21: noOut('M21') })), 'date').status).toBe('fail');
    expect(check(scoreRun(rows, runOf(rows, { M21: noOut('M21') })), 'date').status).toBe('pending');
    expect(check(scoreRun(rows, runOf(rows, { M21: noOut('M21') })), 'time').status).toBe('pending');
  });
  it('拆分：多件事没拿到输出但其余够 12 句、单件事没输出的不超过可拆名额：过；单件事没输出的超过名额：未定；规则句少输出：未定', () => {
    const rows = fullSet();
    expect(check(scoreRun(rows, runOf(rows, { Z01: noOut('Z01') })), 'split').status).toBe('pass');
    const s = scoreRun(rows, runOf(rows, { Z20: noOut('Z20'), Z21: noOut('Z21'), Z22: noOut('Z22') }));
    expect(check(s, 'split')).toMatchObject({ status: 'pending', got: '多件事条数全对 14/14，单件事拆成多条 0 句；另有 3 句没拿到输出，对错未知' });
    expect(check(scoreRun(rows, runOf(rows, { Z41: noOut('Z41') })), 'rule').status).toBe('pending');
    expect(check(scoreRun(rows, runOf(rows, { Z41: noOut('Z41'), Z42: wrong('Z42'), K41: wrong('K41') })), 'rule').status).toBe('fail');
  });
});
