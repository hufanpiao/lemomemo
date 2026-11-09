// 评测骨架 tests/ai/run-core.ts（B3 任务单 BE-1“tests/ai/run.ts 骨架”、第四节文件归属；AI 句库 2.5、5.2、5.3；架构 0.29 第 13 条、2.5）。
// 证明：jsonl 逐行校验、报错带文件和行号、id 不许重复；固定入参照句库 1.2 的常量传给 parseWithAI；按上限的 80% 放慢（每分钟、每天）；
// 每句落盘两份结果（原始输出 raw、校验后结果 checked）和失败原因；报告文件名照 5.3；结果里不出现密钥。
// 服务商是真的 GeminiProvider，fetch 换成回放桩（tests/ai/replay/），不联网、不用真密钥；校验注入真的 shared/schema/ai.ts。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDefaultDay, checkParseOutput, checkVoiceOutput, type AiItem } from '../../shared/schema/ai.ts';
import { makeParseWithAI, type ParseInput } from '../../supabase/functions/_shared/ai/parse-core.ts';
import { PROMPT_VERSION } from '../../supabase/functions/_shared/ai/params.ts';
import { GeminiProvider } from '../../supabase/functions/_shared/ai/gemini.ts';
import { loadCassette, type Cassette } from '../ai/replay/cassette.ts';
import { replay, REPLAY_KEY, REPLAY_MODEL } from '../ai/replay/replay.ts';
import {
  FEATURES, paceOf, parseArgs, parseSet, PROJECTS, reportName, runEval, runSet, type EvalDeps, type EvalRow,
} from '../ai/run-core.ts';

const { parseWithAI } = makeParseWithAI<AiItem>({ checkParseOutput, checkVoiceOutput, checkDefaultDay });
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
      .toEqual({ model: 'gemini-3.5-flash-lite', rpm: 15, rpd: 1000, date: '2026-11-20', replay: null });
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
    expect(reportName('2026-11-20', PROMPT_VERSION.parse, 'gemini-3.5-flash-lite')).toBe('set1-2026-11-20-parse.v2-gemini-3.5-flash-lite');
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
    const out = await runSet(rows(1), async (input) => { seenInput.push(input); return parseWithAI(input, provider); }, { rpm: 60, rpd: 100, ...c });
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
    const out = await runSet(rows(2), (input) => parseWithAI(input, provider), { rpm: 60, rpd: 100, ...fakeClock() });
    expect(out.results.map((r) => [r.id, r.ok, r.reason, r.checked])).toEqual([['Z01', false, 'invalid', null], ['Z02', false, 'error', null]]);
    expect(out.results[0]?.raw).not.toBeNull();
    expect((out.results[0]?.invalid_reasons ?? []).length).toBeGreaterThan(0);
    expect([out.skipped, out.stopped]).toEqual([[], null]);
  });

  it('额度用完（quota）就停下这一轮，剩下的句子不调、列进 skipped（代码审 S4）', async () => {
    const rp = replay(cassettes('parse-ok', 'quota', 'http-500'));
    const provider = new GeminiProvider(REPLAY_MODEL, REPLAY_KEY, rp.fetch);
    const out = await runSet(rows(4), (input) => parseWithAI(input, provider), { rpm: 60, rpd: 100, ...fakeClock() });
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
    const out = await runSet(rows(1), (input) => parseWithAI(input, provider), { rpm: 60, rpd: 100, ...fakeClock() });
    expect(JSON.stringify(out)).not.toContain(REPLAY_KEY);
    expect(Object.keys(out.results[0] ?? {}).sort()).toEqual(['checked', 'errName', 'group', 'id', 'invalid_reasons', 'issues', 'ms', 'ok', 'raw', 'reason', 'scored', 'set_version', 'status']);
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
    expect([r.called, f.calls(), f.written[0]?.name]).toEqual([2, 2, 'set1-2026-11-20-parse.v2-gemini-3.5-flash-lite']);
    expect(f.written[0]?.json).not.toContain('k-not-real');
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
