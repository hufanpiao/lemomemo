// 评测骨架 tests/ai/run-core.ts（B3 任务单 BE-1“tests/ai/run.ts 骨架”、第四节文件归属；AI 句库 2.5、5.2、5.3；架构 0.29 第 13 条、2.5）。
// 证明：jsonl 逐行校验、报错带文件和行号、id 不许重复；固定入参照句库 1.2 的常量传给 parseWithAI；按上限的 80% 放慢（每分钟、每天）；
// 每句落盘两份结果（原始输出 raw、校验后结果 checked）和失败原因；报告文件名照 5.3；结果里不出现密钥。
// 服务商是真的 GeminiProvider，fetch 换成回放桩（tests/ai/replay/），不联网、不用真密钥；校验注入真的 shared/schema/ai.ts。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDefaultDay, checkParseOutput, checkVoiceOutput, type AiItem } from '../../shared/schema/ai.ts';
import { makeParseWithAI, type ParseFail, type ParseInput, type ParseOk } from '../../supabase/functions/_shared/ai/parse-core.ts';
import { PROMPT_VERSION } from '../../supabase/functions/_shared/ai/params.ts';
import { GeminiProvider } from '../../supabase/functions/_shared/ai/gemini.ts';
import { loadCassette, type Cassette } from '../ai/replay/cassette.ts';
import { replay, REPLAY_KEY, REPLAY_MODEL } from '../ai/replay/replay.ts';
import {
  diagLines, FEATURES, onlyName, paceOf, parseArgs, parseOnly, parseSet, PROJECTS, reportName, runEval, runSet, selectRows, type EvalDeps, type EvalRow,
} from '../ai/run-core.ts';

const { recordWithAI } = makeParseWithAI<AiItem>({ checkParseOutput, checkVoiceOutput, checkDefaultDay });
const NOW = 1793581200000;   // 2026-11-02T10:00:00+09:00（句库 1.2）
const row = (o: Partial<EvalRow> = {}) =>
  JSON.stringify({ id: 'Z01', set_version: 'set1-v1.6', group: 'zh', source: 'typed', scored: 'main', text: '明天下午三点开会', now: NOW, tz: 'Asia/Seoul', locale: 'zh', expect: [], accept: {}, ...o });
const cassettes = (...names: string[]): Cassette => ({
  v: 1, provider: 'gemini', origin: 'handmade', note: '拼接',
  entries: names.flatMap((n) => loadCassette(new URL(`../ai/replay/cassettes/${n}.json`, import.meta.url)).entries),
} as Cassette);

/** 假时钟：sleep 只推进时间，记下每次调用开始的时刻 */
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return { clock: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept };
}

describe('评测骨架：读句库', () => {
  it('一行一句，空行跳过；只取调用要的字段，其余原样不动', () => {
    const rows = parseSet('zh.jsonl', `${row()}\n\n${row({ id: 'Z02', scored: 'rule' })}\n`);
    expect(rows.map((r) => [r.id, r.scored, r.text, r.now])).toEqual([['Z01', 'main', '明天下午三点开会', NOW], ['Z02', 'rule', '明天下午三点开会', NOW]]);
  });
  it('字段缺了或不对：报错带文件名和行号，整份不跑', () => {
    const bad: [string, string][] = [
      ['不是 JSON', '{"id":'],
      ['scored 不是三种之一', row({ scored: 'x' as EvalRow['scored'] })],
      ['now 不是整数毫秒', row({ now: '2026-11-02' as unknown as number })],
      ['locale 不是 zh/ko', row({ locale: 'en' as EvalRow['locale'] })],
      ['text 空', row({ text: '' })],
      ['没有 set_version', row({ set_version: undefined as unknown as string })],
    ];
    for (const [why, line] of bad) expect(() => parseSet('ko.jsonl', `${row()}\n${line}`), why).toThrow(/ko\.jsonl:2/);
  });
  it('同一个 id 出现两次（跨文件也算）报错', () => {
    const seen = new Set<string>();
    parseSet('zh.jsonl', row(), seen);
    expect(() => parseSet('mix.jsonl', row(), seen)).toThrow(/mix\.jsonl:1.*Z01/);
  });
});

describe('评测骨架：参数和速度', () => {
  it('按每分钟、每天上限的 80% 放慢；上限不是正整数报错', () => {
    expect(paceOf(15, 1000)).toEqual({ intervalMs: 5000, dailyCap: 800 });   // 15 × 0.8 = 12 次/分 → 5 秒一句
    expect(paceOf(10, 20)).toEqual({ intervalMs: 7500, dailyCap: 16 });
    for (const [rpm, rpd] of [[0, 10], [10, 0], [1.5, 10], [Number.NaN, 10]] as const) expect(() => paceOf(rpm, rpd)).toThrow();
  });
  it('命令行：--model、--rpm、--rpd 必填，没有默认值；--replay 只用回放桩；--date 只认 YYYY-MM-DD；不认的参数报错', () => {
    expect(parseArgs(['--model', 'gemini-3.5-flash-lite', '--rpm', '15', '--rpd', '1000', '--date', '2026-11-20']))
      .toEqual({ model: 'gemini-3.5-flash-lite', rpm: 15, rpd: 1000, date: '2026-11-20', replay: null, only: null });
    expect(parseArgs(['--replay', 'parse-ok', '--rpm', '60', '--rpd', '100', '--date', '2026-11-20']).replay).toBe('parse-ok');
    expect(() => parseArgs(['--rpm', '15', '--rpd', '1000', '--date', '2026-11-20'])).toThrow(/--model/);
    expect(() => parseArgs(['--model', 'm', '--rpd', '1000', '--date', '2026-11-20'])).toThrow(/--rpm/);
    expect(() => parseArgs(['--model', 'm', '--rpm', '1', '--rpd', '1', '--date', '2026-11-2'])).toThrow(/--date/);
    expect(() => parseArgs(['--model', 'm', '--rpm', '1', '--rpd', '1', '--date', '2026-11-20', '--key', 'x'])).toThrow(/--key/);
    // 代码审 S7：同一个参数写两次报错，不许后一个悄悄覆盖前一个
    expect(() => parseArgs(['--model', 'm', '--rpm', '1', '--rpm', '2', '--rpd', '1', '--date', '2026-11-20'])).toThrow(/--rpm 写了两次/);
    // 代码审 M1：模型名在这里就按报告名的规则校验
    for (const bad of ['Gemini-3.5', 'gemini_3', '../x', '-x', `g${'a'.repeat(64)}`]) expect(() => parseArgs(['--model', bad, '--rpm', '1', '--rpd', '1', '--date', '2026-11-20']), bad).toThrow(/--model/);
    expect(parseArgs(['--model', `g${'a'.repeat(63)}`, '--rpm', '1', '--rpd', '1', '--date', '2026-11-20']).model).toHaveLength(64);   // 64 个字符正好收（同 gemini.ts MODEL_RE）
    // 安全审建议 4：回放文件名进路径，套白名单
    for (const bad of ['../../x', 'parse.ok', 'Parse-ok', '-x', 'a/b']) expect(() => parseArgs(['--replay', bad, '--rpm', '1', '--rpd', '1', '--date', '2026-11-20']), bad).toThrow(/--replay/);
  });
  it('报告文件名照句库 5.3：set1-<日期>-<提示词版本>-<模型名>；模型名有怪字符报错', () => {
    expect(reportName('2026-11-20', PROMPT_VERSION.record, 'gemini-3.5-flash-lite')).toBe('set1-2026-11-20-parse.v3-gemini-3.5-flash-lite');
    expect(() => reportName('2026-11-20', 'parse.v2', '../x')).toThrow();
  });
});

describe('评测骨架：逐句调 parseWithAI（回放桩）', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => parseSet('zh.jsonl', row({ id: `Z0${i + 1}` }))[0] as EvalRow);

  it('固定入参照句库 1.2：PROJECTS、FEATURES 常量，now/tz/locale 原样传；每句两份结果：raw（原始输出）和 checked（校验后）', async () => {
    expect([...PROJECTS]).toEqual(['SignPlex', 'NEOX', '官网改版', '이사 준비']);
    expect([...FEATURES]).toEqual(['event', 'todo', 'note', 'anniv']);
    const seenInput: ParseInput[] = [];
    const rp = replay(cassettes('parse-ok'));
    const provider = new GeminiProvider(REPLAY_MODEL, REPLAY_KEY, rp.fetch);
    const c = fakeClock();
    const out = await runSet(rows(1), async (input) => { seenInput.push(input); return recordWithAI(input, provider); }, { rpm: 60, rpd: 100, ...c });
    expect(seenInput).toEqual([{ text: '明天下午三点开会', now: NOW, tz: 'Asia/Seoul', locale: 'zh', projects: PROJECTS, features: FEATURES }]);
    const r = out.results[0];
    expect([r?.id, r?.ok, r?.reason]).toEqual(['Z01', true, null]);
    expect(r?.raw).not.toBeNull();
    expect(r?.checked).not.toBeNull();
    expect(rp.calls).toBe(1);
  });

  it('失败也照记：坏输出 invalid（raw 留着、checked 为 null、带 invalid_reasons），服务商 500 error', async () => {
    const rp = replay(cassettes('bad-schema', 'http-500'));
    const provider = new GeminiProvider(REPLAY_MODEL, REPLAY_KEY, rp.fetch);
    const out = await runSet(rows(2), (input) => recordWithAI(input, provider), { rpm: 60, rpd: 100, ...fakeClock() });
    expect(out.results.map((r) => [r.id, r.ok, r.reason, r.checked])).toEqual([['Z01', false, 'invalid', null], ['Z02', false, 'error', null]]);
    expect(out.results[0]?.raw).not.toBeNull();
    expect((out.results[0]?.invalid_reasons ?? []).length).toBeGreaterThan(0);
    expect([out.skipped, out.stopped]).toEqual([[], null]);
  });

  it('额度用完（quota）就停下这一轮，剩下的句子不调、列进 skipped（代码审 S4）', async () => {
    const rp = replay(cassettes('parse-ok', 'quota', 'http-500'));
    const provider = new GeminiProvider(REPLAY_MODEL, REPLAY_KEY, rp.fetch);
    const out = await runSet(rows(4), (input) => recordWithAI(input, provider), { rpm: 60, rpd: 100, ...fakeClock() });
    expect(out.results.map((r) => [r.id, r.reason])).toEqual([['Z01', null], ['Z02', 'quota']]);
    expect(out.results[1]?.raw).toBeNull();
    expect([out.skipped, out.stopped, rp.calls]).toEqual([['Z03', 'Z04'], 'quota', 2]);
  });

  it('parse 抛异常不中断整轮：这一句记 error 和异常类型名，下一句照跑', async () => {
    let n = 0;
    const out = await runSet(rows(2), async () => {
      if (n++ === 0) throw new TypeError('boom');
      return { ok: false, reason: 'timeout' } as const;
    }, { rpm: 60, rpd: 100, ...fakeClock() });
    expect(out.results.map((r) => [r.reason, r.errName ?? null])).toEqual([['error', 'TypeError'], ['timeout', null]]);
  });

  it('两句之间至少隔 intervalMs（上一句花掉的时间算在里面）；超过每天 80% 的句子不调、列进 skipped', async () => {
    const c = fakeClock();
    let calls = 0;
    const out = await runSet(rows(5), async () => {
      calls++;
      await c.sleep(1000);   // 模拟这一句花了 1 秒
      return { ok: false, reason: 'timeout' } as const;
    }, { rpm: 10, rpd: 5, ...c });   // 7.5 秒一句；每天 4 句
    expect(calls).toBe(4);
    expect(out.skipped).toEqual(['Z05']);
    expect(c.slept).toEqual([1000, 6500, 1000, 6500, 1000, 6500, 1000]);
  });

  it('结果里不出现密钥：回放用的占位密钥不在落盘的 JSON 里', async () => {
    const rp = replay(cassettes('parse-ok'));
    const provider = new GeminiProvider(REPLAY_MODEL, REPLAY_KEY, rp.fetch);
    const out = await runSet(rows(1), (input) => recordWithAI(input, provider), { rpm: 60, rpd: 100, ...fakeClock() });
    expect(JSON.stringify(out)).not.toContain(REPLAY_KEY);
    expect(Object.keys(out.results[0] ?? {}).sort()).toEqual(['checked', 'errName', 'group', 'id', 'invalid_reasons', 'issues', 'ms', 'ok', 'quotaKind', 'raw', 'reason', 'retryMs', 'scored', 'set_version', 'status']);
  });
});

// 11-13 ai-eval #2：第 36 句回 429（每分钟限额），整遍停下、跳过 142 句。分出每分钟 / 每天以后：每分钟的等一会儿重试同一句
describe('评测骨架：额度用完按类型处理（每分钟等了重试，每天停）', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => parseSet('zh.jsonl', row({ id: `Z0${i + 1}` }))[0] as EvalRow);
  const minute = (retryMs: number | null): ParseFail => ({ ok: false, reason: 'quota', status: 429, quotaKind: 'minute', retryMs });
  const okRes: ParseOk<unknown> = { ok: true, value: { items: [] }, raw: { items: [] }, prompt: 'p' };
  /** 按顺序回一串结果（用完了一直回最后一个），记下调了几次 */
  const seq = (...rs: (ParseOk<unknown> | ParseFail)[]) => {
    let i = 0;
    const fn = async () => rs[Math.min(i++, rs.length - 1)] as ParseOk<unknown> | ParseFail;
    return { fn, calls: () => i };
  };

  it('每分钟限额（真 GeminiProvider + 回放 quota-minute，retryDelay 12s）：等 12 秒重试同一句，成功了接着跑；重试那次算进 calls，diag 每次调用一行', async () => {
    const rp = replay(cassettes('parse-ok', 'quota-minute', 'parse-ok', 'parse-ok'));
    const provider = new GeminiProvider(REPLAY_MODEL, REPLAY_KEY, rp.fetch);
    const c = fakeClock();
    const out = await runSet(rows(3), (input) => recordWithAI(input, provider), { rpm: 60, rpd: 100, ...c });
    expect(out.results.map((r) => [r.id, r.reason])).toEqual([['Z01', null], ['Z02', null], ['Z03', null]]);
    expect([out.stopped, out.skipped, out.calls, rp.calls]).toEqual([null, [], 4, 4]);
    expect(c.slept).toEqual([1250, 12_000, 1250]);   // 每分钟 48 句即 1.25 秒一句；重试前等 retryDelay
    expect(out.diag).toEqual([
      'diag Z01 ok status=- err=- ms=0 kind=- retry=-',
      'diag Z02 quota status=429 err=- ms=0 kind=minute retry=12000ms',
      'diag Z02 ok status=- err=- ms=0 kind=- retry=-',
      'diag Z03 ok status=- err=- ms=0 kind=- retry=-',
    ]);
  });
  it('没给 retryDelay 等 60 秒；给得太长最多等 5 分钟；"0s" 也等 1 秒（和服务器写 exhausted_until 同一个 minuteWaitMs）', async () => {
    const a = seq(minute(null), okRes);
    const ca = fakeClock();
    await runSet(rows(1), a.fn, { rpm: 60, rpd: 100, ...ca });
    const b = seq(minute(600_000), okRes);
    const cb = fakeClock();
    await runSet(rows(1), b.fn, { rpm: 60, rpd: 100, ...cb });
    const z = seq(minute(0), okRes);
    const cz = fakeClock();
    await runSet(rows(1), z.fn, { rpm: 60, rpd: 100, ...cz });
    expect([ca.slept, cb.slept, cz.slept, a.calls(), b.calls()]).toEqual([[60_000], [300_000], [1000, 250], 2, 2]);   // 0s 等 1 秒，再补足 1.25 秒的调用间隔
  });
  it('同一句最多重试 2 次：3 次都是每分钟限额就整遍停（stopped = quota），剩下的列进 skipped', async () => {
    const s = seq(minute(5000));
    const c = fakeClock();
    const out = await runSet(rows(3), s.fn, { rpm: 60, rpd: 100, ...c });
    expect([out.results.map((r) => [r.id, r.reason, r.quotaKind, r.retryMs]), out.stopped, out.skipped, out.calls, s.calls()])
      .toEqual([[['Z01', 'quota', 'minute', 5000]], 'quota', ['Z02', 'Z03'], 3, 3]);
    expect(c.slept).toEqual([5000, 5000]);
    expect(out.diag).toHaveLength(3);
  });
  it('每天限额（回放 quota-day，谷歌也给了 retryDelay 1s）：不等不重试，整遍停；认不出的（quota）同样停', async () => {
    for (const name of ['quota-day', 'quota']) {
      const kind = name === 'quota' ? 'unknown' : 'day';
      const rp = replay(cassettes('parse-ok', name, 'parse-ok'));
      const provider = new GeminiProvider(REPLAY_MODEL, REPLAY_KEY, rp.fetch);
      const c = fakeClock();
      const out = await runSet(rows(3), (input) => recordWithAI(input, provider), { rpm: 60, rpd: 100, ...c });
      expect([out.results.map((r) => [r.id, r.reason, r.quotaKind]), out.stopped, out.skipped, out.calls, rp.calls], name)
        .toEqual([[['Z01', null, null], ['Z02', 'quota', kind]], 'quota', ['Z03'], 2, 2]);
      expect(c.slept, name).toEqual([1250]);
      expect(out.diag[1], name).toBe(`diag Z02 quota status=429 err=- ms=0 kind=${kind} retry=${name === 'quota' ? '-' : '1000ms'}`);
    }
  });
  it('重试算进每天 80% 上限：上限 4 句时一句重试过，第 4 句就不调了；重试途中到了上限就停（daily_cap），不再重试', async () => {
    const a = seq(okRes, minute(1000), okRes, okRes, okRes);
    const outA = await runSet(rows(4), a.fn, { rpm: 60, rpd: 5, ...fakeClock() });
    expect([outA.results.map((r) => r.id), outA.skipped, outA.stopped, outA.calls]).toEqual([['Z01', 'Z02', 'Z03'], ['Z04'], 'daily_cap', 4]);
    const b = seq(minute(1000));
    const outB = await runSet(rows(2), b.fn, { rpm: 60, rpd: 3, ...fakeClock() });   // 每天 2 句
    expect([outB.results.map((r) => [r.id, r.reason]), outB.skipped, outB.stopped, outB.calls]).toEqual([[['Z01', 'quota']], ['Z02'], 'daily_cap', 2]);
  });
  it('runEval：meta.called 和返回的 called 是实际调用次数（含重试，工作流按它扣每天上限），diag 每次调用一行', async () => {
    const written: string[] = [];
    const c = fakeClock();
    const s = seq(minute(2000), okRes, okRes);
    const deps: EvalDeps = {
      getKey: () => 'k-not-real', copyShared: async () => {}, readRows: async () => parseSet('zh.jsonl', [row(), row({ id: 'Z02' })].join('\n')),
      loadParse: async () => s.fn, liveProvider: (m) => new GeminiProvider(m, 'k', async () => new Response('{}')),
      replayProvider: () => { throw new Error('不该用回放'); },
      write: async (_w, name, json) => { written.push(json); return `/x/${name}.json`; },
      clock: c.clock, sleep: c.sleep, nowIso: () => '2026-11-20T00:00:00.000Z',
    };
    const r = await runEval(['--model', 'gemini-3.5-flash-lite', '--rpm', '60', '--rpd', '100', '--date', '2026-11-20'], deps);
    const rep = JSON.parse(written[0] ?? '{}') as { meta: { called: number; total: number }; results: unknown[] };
    expect([r.called, rep.meta.called, rep.meta.total, rep.results.length, r.diag.length]).toEqual([3, 3, 2, 2, 3]);
    expect(Object.keys(rep).sort()).toEqual(['meta', 'results', 'skipped', 'stopped']);
  });
});

describe('评测骨架：主流程 runEval 的顺序（代码审 M1、S1、S6）', () => {
  /** 全替身：记下每个动作的先后 */
  function fakeDeps(o: { key?: string | undefined; copyFails?: boolean } = {}) {
    const log: string[] = [];
    const written: { where: string; name: string; json: string }[] = [];
    let calls = 0;
    const c = fakeClock();
    const deps: EvalDeps = {
      getKey: () => { log.push('key'); return o.key; },
      copyShared: async () => { log.push('copy'); if (o.copyFails) throw new Error('copy_failed'); },
      readRows: async () => { log.push('rows'); return parseSet('zh.jsonl', `${row()}\n${row({ id: 'Z02' })}`); },
      loadParse: async () => { log.push('load'); return async () => { calls++; return { ok: false, reason: 'timeout' } as const; }; },
      liveProvider: (model) => { log.push(`live:${model}`); return new GeminiProvider(model, 'k', async () => new Response('{}')); },
      replayProvider: (name) => { log.push(`replay:${name}`); return { provider: new GeminiProvider(REPLAY_MODEL, REPLAY_KEY, async () => new Response('{}')), model: REPLAY_MODEL }; },
      write: async (where, name, json) => { log.push(`write:${where}`); written.push({ where, name, json }); return `/x/${name}.json`; },
      clock: c.clock, sleep: c.sleep, nowIso: () => '2026-11-20T00:00:00.000Z',
    };
    return { deps, log, written, calls: () => calls };
  }
  const LIVE = ['--model', 'gemini-3.5-flash-lite', '--rpm', '60', '--rpd', '100', '--date', '2026-11-20'];

  it('真调用：查密钥 → 复制 → 读句库 → import → 建服务商 → 逐句调 → 写进 reports；报告名照 5.3', async () => {
    const f = fakeDeps({ key: 'k-not-real' });
    const r = await runEval(LIVE, f.deps);
    expect(f.log).toEqual(['key', 'copy', 'rows', 'load', 'live:gemini-3.5-flash-lite', 'write:reports']);
    expect([r.called, f.calls(), f.written[0]?.name]).toEqual([2, 2, 'set1-2026-11-20-parse.v3-gemini-3.5-flash-lite']);
    expect(f.written[0]?.json).not.toContain('k-not-real');
  });

  it('每句一行诊断（打到公开的工作流日志）：编号、结果、状态码、错误名、耗时，不带句子原文、模型输出和密钥', async () => {
    const f = fakeDeps({ key: 'k-not-real' });
    const r = await runEval(LIVE, f.deps);
    expect(r.diag).toHaveLength(r.called);
    for (const line of r.diag) expect(line).toMatch(/^diag [A-Z]\d+ (ok|quota|timeout|invalid|error) status=(\d+|-) err=\S+ ms=\d+ kind=(-|day|minute|unknown) retry=(-|\d+ms)$/);
    expect(r.diag.join(' ')).not.toContain('k-not-real');
  });
  it('diagLines：失败句带上状态码和错误名', () => {
    const base = { set_version: 'v', group: 'zh', scored: 'main' as const, raw: null, checked: null, invalid_reasons: null, issues: null, quotaKind: null, retryMs: null };
    expect(diagLines([
      { ...base, id: 'Z01', ok: true, reason: null, status: null, errName: null, ms: 812 },
      { ...base, id: 'K02', ok: false, reason: 'timeout', status: null, errName: 'TimeoutError', ms: 5003 },
      { ...base, id: 'M03', ok: false, reason: 'error', status: 503, errName: null, ms: 640 },
      { ...base, id: 'K36', ok: false, reason: 'quota', status: 429, errName: null, ms: 135, quotaKind: 'minute', retryMs: 12_000 },
      { ...base, id: 'K37', ok: false, reason: 'quota', status: 429, errName: null, ms: 140, quotaKind: 'unknown' },
    ])).toEqual([
      'diag Z01 ok status=- err=- ms=812 kind=- retry=-', 'diag K02 timeout status=- err=TimeoutError ms=5003 kind=- retry=-',
      'diag M03 error status=503 err=- ms=640 kind=- retry=-', 'diag K36 quota status=429 err=- ms=135 kind=minute retry=12000ms',
      'diag K37 quota status=429 err=- ms=140 kind=unknown retry=-',
    ]);
  });

  it('模型名不合法、参数写重：什么都不做，一次都不调（M1）', async () => {
    for (const argv of [[...LIVE.slice(0, 1), 'Gemini_X', ...LIVE.slice(2)], [...LIVE, '--date', '2026-11-21']]) {
      const f = fakeDeps({ key: 'k-not-real' });
      await expect(runEval(argv, f.deps)).rejects.toThrow();
      expect([f.log, f.calls()]).toEqual([[], 0]);
    }
  });

  it('真调用没有密钥：先停，不复制、不读句库、不调（S1）', async () => {
    for (const key of [undefined, '']) {
      const f = fakeDeps({ key });
      await expect(runEval(LIVE, f.deps)).rejects.toThrow(/GEMINI_EVAL_KEY/);
      expect([f.log, f.calls()]).toEqual([['key'], 0]);
    }
  });

  it('复制步骤失败：不读句库、不调', async () => {
    const f = fakeDeps({ key: 'k-not-real', copyFails: true });
    await expect(runEval(LIVE, f.deps)).rejects.toThrow(/copy_failed/);
    expect([f.log, f.calls()]).toEqual([['key', 'copy'], 0]);
  });

  it('回放：不问密钥、不建真服务商，结果写进临时目录（不进仓库）', async () => {
    const f = fakeDeps();
    await runEval(['--replay', 'parse-ok', '--rpm', '60', '--rpd', '100', '--date', '2026-11-20'], f.deps);
    expect(f.log).toEqual(['replay:parse-ok', 'copy', 'rows', 'load', 'write:temp']);
    expect(JSON.parse(f.written[0]?.json ?? '{}').meta.mode).toBe('replay:parse-ok');
  });
});

describe('评测骨架：--only 只跑指定句子（S19 补跑）', () => {
  const R3 = parseSet('zh.jsonl', [row(), row({ id: 'Z02' }), row({ id: 'K10', locale: 'ko' })].join('\n'));
  /** 和上面同样的全替身，句库三句 Z01、Z02、K10；记下每次调用的句子 */
  function deps3(key?: string) {
    const log: string[] = [];
    const texts: string[] = [];
    const written: { where: string; name: string; json: string }[] = [];
    const c = fakeClock();
    let n = 0;
    const d: EvalDeps = {
      getKey: () => { log.push('key'); return key; },
      copyShared: async () => { log.push('copy'); },
      readRows: async () => { log.push('rows'); return R3; },
      loadParse: async () => { log.push('load'); return async (input) => { texts.push(input.locale); return { ok: false, reason: 'timeout' } as const; }; },
      liveProvider: (model) => { log.push(`live:${model}`); return new GeminiProvider(model, 'k', async () => new Response('{}')); },
      replayProvider: (name) => { log.push(`replay:${name}`); return { provider: new GeminiProvider(REPLAY_MODEL, REPLAY_KEY, async () => new Response('{}')), model: REPLAY_MODEL }; },
      write: async (where, name, json) => { log.push(`write:${where}`); written.push({ where, name, json }); return `/x/${name}.json`; },
      clock: c.clock, sleep: c.sleep, nowIso: () => `2026-11-20T03:15:22.${String(n++).padStart(3, '0')}Z`,
    };
    return { d, log, texts, written };
  }
  const BASE = ['--rpm', '60', '--rpd', '100', '--date', '2026-11-20'];

  it('参数：逗号分开；空项、重复、怪字符、空值都报错', () => {
    expect(parseArgs(['--replay', 'parse-ok', ...BASE, '--only', 'K10,Z01']).only).toEqual(['K10', 'Z01']);
    expect(parseOnly(' Z01 , K10 ')).toEqual(['Z01', 'K10']);
    for (const bad of ['Z01,,K10', 'Z01,', ',Z01', 'Z01,Z01', '../x', 'Z 01', 'Z01;rm', `Z${'1'.repeat(32)}`]) expect(() => parseOnly(bad), bad).toThrow(/--only/);
    expect(() => parseOnly(Array.from({ length: 501 }, (_, i) => `Z${i}`).join(','))).toThrow(/最多 500/);
    expect(() => parseArgs(['--replay', 'parse-ok', ...BASE, '--only'])).toThrow(/--only 缺值/);
    expect(() => parseArgs(['--replay', 'parse-ok', ...BASE, '--only', 'Z01', '--only', 'Z02'])).toThrow(/--only 写了两次/);
  });

  it('挑句子保持句库顺序；有一个 id 句库里没有就报错，列出全部缺的', () => {
    expect(selectRows(R3, ['K10', 'Z01']).map((r) => r.id)).toEqual(['Z01', 'K10']);
    expect(selectRows(R3, null).map((r) => r.id)).toEqual(['Z01', 'Z02', 'K10']);
    expect(() => selectRows(R3, ['Z01', 'X9', 'Y9'])).toThrow('--only 里有句库没有的 id：X9、Y9');
  });

  it('回放模式：只调指定的句子，结果名另起（only-…-t<时刻>），meta 记下 only 和 total', async () => {
    const f = deps3();
    const r = await runEval(['--replay', 'parse-ok', ...BASE, '--only', 'K10'], f.d);
    expect(f.log).toEqual(['replay:parse-ok', 'copy', 'rows', 'load', 'write:temp']);
    expect([r.called, f.texts]).toEqual([1, ['ko']]);
    const name = f.written[0]?.name ?? '';
    expect(name).toBe(`only-set1-2026-11-20-${PROMPT_VERSION.record}-${REPLAY_MODEL}-t031522000`);
    expect(name.startsWith('set1-')).toBe(false);   // 工作流按 set1-*.json 找第一遍，补跑不能混进去
    const meta = JSON.parse(f.written[0]?.json ?? '{}').meta;
    expect([meta.only, meta.total, meta.called]).toEqual([['K10'], 1, 1]);
  });

  it('真调用模式：同样只调指定的句子，写进 reports', async () => {
    const f = deps3('k-not-real');
    const r = await runEval(['--model', 'gemini-3.5-flash-lite', ...BASE, '--only', 'Z02,K10'], f.d);
    expect(f.log).toEqual(['key', 'copy', 'rows', 'load', 'live:gemini-3.5-flash-lite', 'write:reports']);
    expect([r.called, f.texts]).toEqual([2, ['zh', 'ko']]);
    expect(f.written[0]?.name).toMatch(/^only-set1-2026-11-20-parse\.v\d+-gemini-3\.5-flash-lite-t\d{9}$/);
    expect(f.written[0]?.json).not.toContain('k-not-real');
  });

  it('id 不存在：报错退出，不 import、一句都不调、不落盘（回放和真调用都一样）', async () => {
    for (const argv of [['--replay', 'parse-ok', ...BASE, '--only', 'Z01,X9'], ['--model', 'gemini-3.5-flash-lite', ...BASE, '--only', 'X9']]) {
      const f = deps3('k-not-real');
      await expect(runEval(argv, f.d)).rejects.toThrow(/句库没有的 id：X9/);
      expect(f.log.filter((x) => x === 'load' || x.startsWith('write'))).toEqual([]);
      expect(f.texts).toEqual([]);
    }
  });

  it('不带 --only：报告名、meta 照旧（only 为 null），和第一遍完全一样', async () => {
    const f = deps3();
    await runEval(['--replay', 'parse-ok', ...BASE], f.d);
    expect(f.written[0]?.name).toBe(reportName('2026-11-20', PROMPT_VERSION.record, REPLAY_MODEL));
    expect(JSON.parse(f.written[0]?.json ?? '{}').meta.only).toBeNull();
    expect(f.texts).toHaveLength(3);
  });

  it('结果名：时刻不是 UTC ISO 报错', () => {
    expect(onlyName('set1-x', '2026-11-20T23:59:59.999Z')).toBe('only-set1-x-t235959999');
    expect(() => onlyName('set1-x', '2026-11-20T23:59:59+09:00')).toThrow();
  });
});

describe('评测骨架：run.ts 入口源码（S3、S6）', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'ai', 'run.ts'), 'utf8');
  it('只读三个环境变量：GEMINI_EVAL_KEY，和给复制子进程的 PATH、SYSTEMROOT；子进程 clearEnv，不继承密钥', () => {
    expect(src.match(/Deno\.env\.get\(/g)).toHaveLength(2);
    expect(src).toContain("getKey: () => Deno.env.get('GEMINI_EVAL_KEY')");
    expect(src).toContain("for (const k of ['PATH', 'SYSTEMROOT'])");
    expect(src).toMatch(/new Deno\.Command\('node', \{[^}]*clearEnv: true, env,/);
    expect(src).not.toMatch(/Deno\[|globalThis\.Deno|Deno\.env\.toObject/);
  });
  it('回放结果走 makeTempDir；主流程全交给 runEval', () => {
    expect(src).toMatch(/where === 'temp' \? pathToFileURL\(`\$\{await Deno\.makeTempDir\(/);
    expect(src).toContain('runEval(Deno.args, deps)');
  });
});
