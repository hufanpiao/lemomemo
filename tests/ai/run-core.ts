// 评测骨架的纯逻辑（B3 任务单 BE-1“tests/ai/run.ts 骨架”；AI 句库 2.5、5.2、5.3；架构 0.29 第 13 条）。
// Deno 入口 tests/ai/run.ts 负责：执行和部署同一个复制步骤、读文件、建服务商、写报告。这里不碰文件、网络和环境变量，
// Node（Vitest：tests/edge/ai-eval-run.test.ts）和 Deno 都能 import。
// • 读句库：一行一句，只校验调用要用的字段，报错带文件名和行号；id 跨文件不许重复。
// • 固定入参照句库 1.2 / 2.5 写成常量：PROJECTS、FEATURES；now、tz、locale 原样传给 parseWithAI。
// • 速度：按 AI Studio 额度截图上每分钟、每天上限的 80% 放慢；超过每天 80% 的句子不调，列进 skipped。
// • 每句落盘两份结果：raw（模型原始输出）和 checked（校验后结果），加失败原因。只做骨架：不评分、不补跑（评分和“错的句子补跑 3 次”归评测员）。
import type { AiKindLike, ParseFail, ParseInput, ParseOk } from '../../supabase/functions/_shared/ai/parse-core.ts';
import { PROMPT_VERSION, TASK_PARAMS } from '../../supabase/functions/_shared/ai/params.ts';
import type { AIProvider } from '../../supabase/functions/_shared/ai/provider.ts';

/** 句库 2.5：所有句子相同的固定入参（1.2） */
export const PROJECTS: readonly string[] = Object.freeze(['SignPlex', 'NEOX', '官网改版', '이사 준비']);
export const FEATURES: readonly AiKindLike[] = Object.freeze(['event', 'todo', 'note', 'anniv'] as const);

export const SCORED = ['main', 'rule', 'observe'] as const;
export interface EvalRow {
  id: string;
  set_version: string;
  group: string;
  scored: (typeof SCORED)[number];
  text: string;
  now: number;
  tz: string;
  locale: 'zh' | 'ko';
}

const str = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** 读一个 jsonl 文件；seen 跨文件查 id 重复 */
export function parseSet(file: string, content: string, seen: Set<string> = new Set()): EvalRow[] {
  const out: EvalRow[] = [];
  content.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    const at = `${file}:${i + 1}`;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`${at} 不是 JSON`);
    }
    const bad = (k: string) => new Error(`${at} 字段 ${k} 缺失或不对`);
    for (const k of ['id', 'set_version', 'group', 'text', 'tz'] as const) if (!str(o[k])) throw bad(k);
    if (!SCORED.includes(o['scored'] as EvalRow['scored'])) throw bad('scored');
    if (!Number.isSafeInteger(o['now'])) throw bad('now');
    if (o['locale'] !== 'zh' && o['locale'] !== 'ko') throw bad('locale');
    const id = o['id'] as string;
    if (seen.has(id)) throw new Error(`${at} id 重复：${id}`);
    seen.add(id);
    out.push({
      id, set_version: o['set_version'] as string, group: o['group'] as string, scored: o['scored'] as EvalRow['scored'],
      text: o['text'] as string, now: o['now'] as number, tz: o['tz'] as string, locale: o['locale'] as EvalRow['locale'],
    });
  });
  return out;
}

/** 每分钟、每天上限 × 80%（句库 5.2）→ 两句开始之间的最小间隔、每天最多调几句 */
export function paceOf(rpm: number, rpd: number): { intervalMs: number; dailyCap: number } {
  const perMin = Math.floor(rpm * 0.8);
  const cap = Math.floor(rpd * 0.8);
  if (!Number.isInteger(rpm) || !Number.isInteger(rpd) || perMin < 1 || cap < 1) throw new Error('rpm、rpd 要是正整数，且乘 0.8 后至少 1');
  return { intervalMs: Math.ceil(60_000 / perMin), dailyCap: cap };
}

/** 模型名进报告名：只认小写字母、数字、点和横线；长度上限 64，和 gemini.ts 的 MODEL_RE 一致（安全审建议 5） */
const MODEL_NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
/** 回放文件名进路径（cassettes/<名>.json）：只认小写字母、数字和横线，不许 ../（安全审建议 4） */
const REPLAY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface RunArgs { model: string | null; rpm: number; rpd: number; date: string; replay: string | null }

/** 命令行：--model（真调用时必填）、--rpm、--rpd、--date 必填，没有默认值（上限照 B0 存档的额度截图填）；--replay <回放文件名> 只用回放桩 */
export function parseArgs(argv: readonly string[]): RunArgs {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i] ?? '';
    if (!['--model', '--rpm', '--rpd', '--date', '--replay'].includes(k)) throw new Error(`不认的参数：${k}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${k} 缺值`);
    if (m.has(k)) throw new Error(`${k} 写了两次`);   // 代码审 S7：不许后一个悄悄覆盖前一个
    m.set(k, v);
  }
  const replay = m.get('--replay') ?? null;
  const model = m.get('--model') ?? null;
  if (model === null && replay === null) throw new Error('--model 必填（或用 --replay 只跑回放）');
  // 代码审 M1：模型名进报告名，在这里就按报告名的规则校验，免得整套真调完了才在算报告名时出错、一行都没落盘
  if (model !== null && !MODEL_NAME_RE.test(model)) throw new Error('--model 只认小写字母、数字、点和横线，最长 64 个字符');
  if (replay !== null && !REPLAY_NAME_RE.test(replay)) throw new Error('--replay 只认小写字母、数字和横线（tests/ai/replay/cassettes/ 里的文件名）');
  const int = (k: string): number => {
    const v = m.get(k);
    if (v === undefined || !/^[1-9]\d*$/.test(v)) throw new Error(`${k} 必填，正整数`);
    return Number(v);
  };
  const rpm = int('--rpm');
  const rpd = int('--rpd');
  const date = m.get('--date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date 必填，YYYY-MM-DD');
  return { model, rpm, rpd, date, replay };
}

/** 句库 5.3：set1-<日期>-<提示词版本>-<模型名>（报告 .md 和结果 .json 同名） */
export function reportName(date: string, prompt: string, model: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[a-z0-9][a-z0-9.]*$/.test(prompt) || !MODEL_NAME_RE.test(model)) throw new Error('报告名里有不认的字符');
  return `set1-${date}-${prompt}-${model}`;
}

export interface EvalResult {
  id: string;
  set_version: string;
  group: string;
  scored: EvalRow['scored'];
  ok: boolean;
  /** 失败原因：quota、timeout、invalid、error；成功为 null */
  reason: ParseFail['reason'] | null;
  /** 模型原始输出（没拿到输出为 null） */
  raw: unknown;
  /** 校验后结果（校验没过或失败为 null） */
  checked: unknown;
  invalid_reasons: string[] | null;
  issues: unknown[] | null;
  status: number | null;
  errName: string | null;
  ms: number;
}

export interface RunOpts { rpm: number; rpd: number; clock: () => number; sleep: (ms: number) => Promise<void> }
export type ParseFn = (input: ParseInput) => Promise<ParseOk<unknown> | ParseFail>;
/** 这一轮为什么提前停：每天上限（本次运行的 80%）、额度用完（代码审 S4）；没停为 null */
export type StopReason = 'daily_cap' | 'quota' | null;

/**
 * 逐句调（不并发）；一句抛异常只记这一句，不中断整轮。
 * • 每天上限只按本次运行计（代码审 S2）：同一天同一模型跑第二次，要自己把 --rpd 扣掉上一次已调的句数，否则合计会超过 80%。
 * • 拿到 quota（额度用完）就停下这一轮，剩下的句子列进 skipped（代码审 S4：再调只会接着 429、白耗请求）。
 */
export async function runSet(rows: readonly EvalRow[], parse: ParseFn, o: RunOpts): Promise<{ results: EvalResult[]; skipped: string[]; stopped: StopReason }> {
  const { intervalMs, dailyCap } = paceOf(o.rpm, o.rpd);
  const results: EvalResult[] = [];
  const skipped: string[] = [];
  let stopped: StopReason = null;
  let last: number | null = null;
  for (const r of rows) {
    if (stopped === null && results.length >= dailyCap) stopped = 'daily_cap';
    if (stopped !== null) {
      skipped.push(r.id);
      continue;
    }
    if (last !== null) {
      const wait = last + intervalMs - o.clock();
      if (wait > 0) await o.sleep(wait);
    }
    const t0 = o.clock();
    last = t0;
    const base = { id: r.id, set_version: r.set_version, group: r.group, scored: r.scored };
    let res: ParseOk<unknown> | ParseFail;
    try {
      res = await parse({ text: r.text, now: r.now, tz: r.tz, locale: r.locale, projects: PROJECTS, features: FEATURES });
    } catch (e) {
      results.push({ ...base, ok: false, reason: 'error', raw: null, checked: null, invalid_reasons: null, issues: null, status: null, errName: e instanceof Error ? e.name : 'unknown', ms: o.clock() - t0 });
      continue;
    }
    const ms = o.clock() - t0;
    if (res.ok) {
      results.push({ ...base, ok: true, reason: null, raw: res.raw, checked: res.value, invalid_reasons: null, issues: null, status: null, errName: null, ms });
    } else {
      results.push({
        ...base, ok: false, reason: res.reason, raw: res.raw ?? null, checked: null, invalid_reasons: res.invalid_reasons ?? null,
        issues: res.issues ?? null, status: res.status ?? null, errName: res.errName ?? null, ms,
      });
      if (res.reason === 'quota') stopped = 'quota';
    }
  }
  return { results, skipped, stopped };
}

/** run.ts 的外部动作，全部注入（Deno 入口接真的，单测接替身） */
export interface EvalDeps {
  /** 只读 GEMINI_EVAL_KEY（真调用才问） */
  getKey(): string | undefined;
  /** 和部署同一个复制步骤 */
  copyShared(): Promise<void>;
  readRows(): Promise<EvalRow[]>;
  /** 复制完再 import 正式的 parse-with-ai.ts */
  loadParse(): Promise<(input: ParseInput, p: AIProvider) => Promise<ParseOk<unknown> | ParseFail>>;
  liveProvider(model: string, key: string): AIProvider;
  replayProvider(name: string): { provider: AIProvider; model: string };
  /** where = reports：tests/ai/reports/；temp：系统临时目录（回放结果不进仓库）。返回写到的路径 */
  write(where: 'reports' | 'temp', name: string, json: string): Promise<string>;
  clock(): number;
  sleep(ms: number): Promise<void>;
  nowIso(): string;
}

/**
 * 主流程，顺序是定死的：
 * ① 解析参数（模型名、重复参数在这里拦）→ ② 真调用先查密钥（代码审 S1）→ ③ 算好报告名（代码审 M1）
 * → ④ 复制步骤 → ⑤ 读句库 → ⑥ import parseWithAI、建服务商 → ⑦ 逐句调 → ⑧ 落盘。①～③ 任何一步不过，后面一步都不做。
 */
export async function runEval(argv: readonly string[], d: EvalDeps): Promise<{ file: string; called: number; skipped: number; stopped: StopReason }> {
  const args = parseArgs(argv);
  let key: string | null = null;
  if (args.replay === null) {
    key = d.getKey() ?? '';
    if (key === '') throw new Error('没有 GEMINI_EVAL_KEY：真调用只在评测工作流里跑（句库 5.2），本机请用 --replay');
  }
  const rp = args.replay !== null ? d.replayProvider(args.replay) : null;
  const model = rp ? rp.model : (args.model ?? '');
  const name = reportName(args.date, PROMPT_VERSION.parse, model);
  await d.copyShared();
  const rows = await d.readRows();
  const parseWithAI = await d.loadParse();
  const provider = rp ? rp.provider : d.liveProvider(model, key ?? '');
  const started = d.nowIso();
  const out = await runSet(rows, (input) => parseWithAI(input, provider), { rpm: args.rpm, rpd: args.rpd, clock: d.clock, sleep: d.sleep });
  const report = {
    meta: {
      name, mode: args.replay !== null ? `replay:${args.replay}` : 'live', model, prompt: PROMPT_VERSION.parse, params: TASK_PARAMS.parse,
      set_versions: [...new Set(rows.map((r) => r.set_version))], projects: PROJECTS, features: FEATURES,
      rpm: args.rpm, rpd: args.rpd, started, finished: d.nowIso(), total: rows.length, called: out.results.length, stopped: out.stopped,
    },
    ...out,
  };
  const file = await d.write(args.replay !== null ? 'temp' : 'reports', name, `${JSON.stringify(report, null, 2)}\n`);
  return { file, called: out.results.length, skipped: out.skipped.length, stopped: out.stopped };
}
