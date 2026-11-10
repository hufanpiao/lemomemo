// 测试集 ① 判分的纯逻辑（B3 任务单 S19、第四节 tests/ai/score.ts 一行；AI 句库 1.4、2.5、4.1、5.3；R-162、R-175、R-194）。
// 输入：tests/ai/set1/*.jsonl 的期望（parseExpect）＋ run.ts 落盘的结果 JSON（第一遍），可选上一次的判分结果（基线）和补跑结果。
// 输出：每句对错和错在哪个字段、4.1 表每一项过没过、5.3 要的几项统计。不碰文件、网络和环境变量，Node（Vitest：tests/edge/ai-eval-score.test.ts）和 Deno 都能 import。
// • 判分用校验后结果（checked）；“记成重复”和 5.3 里“按原始输出统计”的几项看原始输出（raw）。
// • 门槛只用第一遍判（4.2“跑一遍定输赢”）；补跑结果只用来分“稳定错 / 偶尔错”，给“不比上一次差”一项。
// • B3 不评 intent（任务单 S19、句库 1.4 intent 一行）；B 路本机规则在 Vitest 里跑（句库 5.2 末条），不在这里，只列出来、不进结论。
// • 句库和结果对不上（分母不是 40 / 13 / 18、有句子没跑到、句库版本不同）时结论是“未定”，不凑成通过。
// 输出里只有句子 id、字段名和数字，不放句子原文和模型原文（工作流摘要页是公开的；原文在结果 JSON 里，只进工作流产物）。

export const KINDS = ['event', 'todo', 'note', 'anniv'] as const;
export type Kind = (typeof KINDS)[number];
export const SCORED = ['main', 'rule', 'observe'] as const;
/** 三组计分句（4.1 前四行） */
export const LANG_GROUPS = ['zh', 'ko', 'mix'] as const;
export const OWNER = 'owner';

/** 4.1 表的数字（R-162、R-175、R-194），一处写死 */
export const GATE = Object.freeze({
  groupSize: 40,
  group: { zh: 36, ko: 36, mix: 34 } as Record<(typeof LANG_GROUPS)[number], number>,
  total: 108,
  ownerSize: 13,
  ownerRate: 0.9,
  dateRate: 0.97,
  dateMadeUpMax: 0,
  timeRate: 0.97,
  timeMadeUpMax: 1,
  multiSize: 14,
  multiOkMin: 12,
  singleSplitMax: 2,
  regressStableMax: 2,   // “达到 3 句或以上就算变差”
  retryTimes: 3,
  ruleSize: 18,
  ruleOk: 17,
});
/** 规则句里的重复说法（句库 4.1 最后一行、B 路一行点名的 6 句）：拆成多条或记成重复都算 */
export const REPEAT_IDS: readonly string[] = Object.freeze(['Z41', 'Z42', 'K41', 'K42', 'M41', 'M42']);

export interface Anniv { type: string; calendar: string; month: number; day: number; is_leap: boolean; year: number | null }
export interface Confirm { past: string; next: string }
export interface ExpItem {
  kind: Kind;
  date?: string | null;
  due?: string | null;
  time?: string | null;
  duration_min?: number | null;
  title_has?: string[];
  title_forbid?: string[];
  project?: string | null;
  important?: boolean;
  confirm?: Confirm | null;
  date_basis?: string | null;
  anniv?: Anniv;
}
export interface SetRow {
  id: string;
  set_version: string;
  group: string;
  scored: (typeof SCORED)[number];
  expect: ExpItem[];
  /** 月份本来没有的观察句（O05、O06、O08）：理想结果是 AI 照写字面日子、bad_date 整份退回（句库 2.5、2.6） */
  expect_invalid_date: boolean;
  /** 人名不评（M31、M32，句库 2.5）：这两句的“标题须含”只列事由、不列人名，人名写成什么样都不影响标题一项 */
  title_ignore_person: boolean;
  /** 负责人组：负责人逐句确认过期望（句库第 3 节“确认后计分”）；有一句不是 true，负责人一项就是未定 */
  owner_confirmed: boolean;
}

/** 句库 2.5 写到的键，多一个就停（拼错的键会被悄悄当成“不评”） */
const ROW_KEYS = new Set(['id', 'set_version', 'group', 'source', 'scored', 'text', 'now', 'tz', 'locale', 'expect', 'accept', 'note', 'expect_invalid_date', 'title_ignore_person', 'owner_confirmed']);
const ITEM_KEYS = new Set(['kind', 'date', 'due', 'time', 'duration_min', 'title_has', 'title_forbid', 'project', 'important', 'confirm', 'date_basis', 'anniv', 'short']);
const ANNIV_KEYS = new Set(['type', 'calendar', 'month', 'day', 'is_leap', 'year']);
const unknownKey = (o: Record<string, unknown>, ok: Set<string>) => Object.keys(o).find((k) => !ok.has(k));

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');
const nullStr = (v: unknown) => v === null || typeof v === 'string';

/** 读一个 jsonl 的期望部分（调用要用的字段由 run-core.ts 的 parseSet 校验）；报错带文件名和行号 */
export function parseExpect(file: string, content: string): SetRow[] {
  const out: SetRow[] = [];
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
    if (!isObj(o)) throw new Error(`${at} 不是对象`);
    const extra = unknownKey(o, ROW_KEYS);
    if (extra !== undefined) throw new Error(`${at} 不认的键：${extra}（句库 2.5 没有这个键，先改判分再跑）`);
    for (const k of ['expect_invalid_date', 'title_ignore_person', 'owner_confirmed'] as const) if (k in o && typeof o[k] !== 'boolean') throw bad(k);
    for (const k of ['id', 'set_version', 'group'] as const) if (typeof o[k] !== 'string' || o[k] === '') throw bad(k);
    if (!SCORED.includes(o['scored'] as SetRow['scored'])) throw bad('scored');
    // accept 的写法句库没定（2.5：测试集 ① 没有两可的句子）：出现非空的就停，先把判分改了再跑，不悄悄当成没有
    if (o['accept'] !== undefined && !(isObj(o['accept']) && Object.keys(o['accept']).length === 0)) throw new Error(`${at} accept 不是空的：score-core.ts 还不认，先按句库补判法`);
    if (!Array.isArray(o['expect'])) throw bad('expect');
    const expect = (o['expect'] as unknown[]).map((e, k) => {
      const w = (f: string) => new Error(`${at} expect[${k}].${f} 缺失或不对`);
      if (!isObj(e) || !KINDS.includes(e['kind'] as Kind)) throw w('kind');
      const ek = unknownKey(e, ITEM_KEYS);
      if (ek !== undefined) throw new Error(`${at} expect[${k}] 不认的键：${ek}`);
      // short 只在随手记、纪念日写 null（句库 2.5）；日程、待办的 short 只查格式，不写期望
      if ('short' in e && e['short'] !== null) throw w('short');
      if (e['kind'] !== 'anniv' && 'anniv' in e) throw w('anniv');
      // 计分句、规则句的日程、待办必须写日子、time、confirm（句库 2.5）：不写就停，免得拼漏一个键被当成“不评”。
      // 只有观察句可以不写 time，表示时间不评（O05、O08：月份本来没有的日子，时刻不是考点）
      if ((e['kind'] === 'event' || e['kind'] === 'todo') && o['scored'] !== 'observe') {
        for (const f of [e['kind'] === 'event' ? 'date' : 'due', 'time', 'confirm']) if (!(f in e)) throw w(f);
      }
      for (const f of ['date', 'due', 'time', 'project', 'date_basis'] as const) if (f in e && !nullStr(e[f])) throw w(f);
      if ('duration_min' in e && e['duration_min'] !== null && !Number.isInteger(e['duration_min'])) throw w('duration_min');
      for (const f of ['title_has', 'title_forbid'] as const) if (f in e && !strArr(e[f])) throw w(f);
      if ('important' in e && typeof e['important'] !== 'boolean') throw w('important');
      if ('confirm' in e && e['confirm'] !== null && !(isObj(e['confirm']) && typeof e['confirm']['past'] === 'string' && typeof e['confirm']['next'] === 'string')) throw w('confirm');
      if (e['kind'] === 'anniv') {
        const a = e['anniv'];
        if (!isObj(a) || typeof a['type'] !== 'string' || typeof a['calendar'] !== 'string' || !Number.isInteger(a['month']) || !Number.isInteger(a['day'])
          || typeof a['is_leap'] !== 'boolean' || !(a['year'] === null || Number.isInteger(a['year'])) || unknownKey(a, ANNIV_KEYS) !== undefined) throw w('anniv');
      }
      return e as unknown as ExpItem;
    });
    out.push({
      id: o['id'] as string, set_version: o['set_version'] as string, group: o['group'] as string, scored: o['scored'] as SetRow['scored'],
      expect, expect_invalid_date: o['expect_invalid_date'] === true, title_ignore_person: o['title_ignore_person'] === true,
      owner_confirmed: o['owner_confirmed'] === true,
    });
  });
  return out;
}

/** run.ts 落盘的一句（run-core.ts 的 EvalResult，这里只用到这几项） */
export interface RunResult { id: string; ok: boolean; reason: string | null; raw: unknown; checked: unknown; invalid_reasons: string[] | null }
export interface RunReport { meta: { name: string; set_versions: string[]; total: number; model?: string; prompt?: string }; results: RunResult[]; skipped: string[]; stopped: string | null }

/** 校验后的一条（shared/schema/ai.ts 的 AiItem），按可能缺键来读 */
type Item = Record<string, unknown>;
const itemsOf = (v: unknown): Item[] | null => (isObj(v) && Array.isArray(v['items']) ? (v['items'] as unknown[]).filter(isObj) : null);

/** 比较前去掉空格、统一全角半角、英文不分大小写（句库 1.4 标题一行） */
export const normTitle = (s: string): string => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const minutes = (t: unknown): number | null => {
  if (typeof t !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
const graphemes = (s: string): number => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length;
/** 日程看 date、待办看 due（句库 1.4 日期一行） */
const dayOf = (it: Item): unknown => (it['kind'] === 'event' ? it['date'] : it['kind'] === 'todo' ? it['due'] : null) ?? null;
const timed = (k: unknown) => k === 'event' || k === 'todo';

export interface ItemJudge {
  /** 错的字段名；空 = 这一条全对 */
  wrong: string[];
  /** 4.1 日期一行：评不评、对不对、期望为空却编了日子 */
  date: { on: boolean; ok: boolean; madeUp: boolean };
  time: { on: boolean; ok: boolean; madeUp: boolean };
  /** 写了期望 basis 的条目，basis 对不对（main、observe 只记录；rule 已算进 wrong） */
  basis: boolean | null;
}

/** 一条期望和一条校验后结果逐字段比（句库 1.4）；a 为 null = 这一条没有对应的结果 */
export function judgeItem(e: ExpItem, a: Item | null, row: Pick<SetRow, 'scored'>): ItemJudge {
  const dateOn = e.kind !== 'note';
  // 观察句不写 time = 时间不评（parseExpect 只许观察句这样写）
  const timeOn = timed(e.kind) && 'time' in e;
  if (a === null) return { wrong: ['missing'], date: { on: dateOn, ok: false, madeUp: false }, time: { on: timeOn, ok: false, madeUp: false }, basis: 'date_basis' in e ? false : null };
  const wrong: string[] = [];
  if (a['kind'] !== e.kind) wrong.push('kind');
  // 日期
  let dateOk = true;
  let dateMadeUp = false;
  if (e.kind === 'event' || e.kind === 'todo') {
    const want = (e.kind === 'event' ? e.date : e.due) ?? null;
    const got = dayOf(a);
    dateOk = want === got;
    dateMadeUp = want === null && got !== null;
  } else if (e.kind === 'anniv') {
    const x = a['anniv'];
    dateOk = isObj(x) && x['month'] === e.anniv?.month && x['day'] === e.anniv?.day && x['calendar'] === e.anniv?.calendar && x['is_leap'] === e.anniv?.is_leap;
  }
  if (!dateOk) wrong.push('date');
  // 时间（日程、待办都评，相差 0 分钟；期望为空的必须为空）
  let timeOk = true;
  let timeMadeUp = false;
  if (timeOn) {
    const want = minutes(e.time ?? null);
    const got = timed(a['kind']) ? minutes(a['time'] ?? null) : null;
    timeOk = want === got && !Number.isNaN(got);
    timeMadeUp = want === null && got !== null;
    if (!timeOk) wrong.push('time');
  }
  if (typeof e.duration_min === 'number' && a['duration_min'] !== e.duration_min) wrong.push('duration_min');
  // basis：只有规则句按它评（句库 1.4 date_basis 一行、2.5）
  let basis: boolean | null = null;
  if ('date_basis' in e) {
    basis = (a['date_basis'] ?? null) === (e.date_basis ?? null);
    if (!basis && row.scored === 'rule') wrong.push('date_basis');
  }
  // confirm：日程、待办，不该问的必须不带
  if (timed(e.kind)) {
    const want = e.confirm ?? null;
    const got = a['confirm'] ?? null;
    const same = want === null ? got === null : isObj(got) && got['past'] === want.past && got['next'] === want.next;
    if (!same) wrong.push('confirm');
  }
  // 标题：须含、不许含；随手记的标题可以为空，须含的词在标题或正文里出现即可
  const title = normTitle(typeof a['title'] === 'string' ? a['title'] : '');
  const hay = e.kind === 'note' ? title + normTitle(typeof a['body'] === 'string' ? a['body'] : '') : title;
  if (!(e.title_has ?? []).every((w) => hay.includes(normTitle(w)))) wrong.push('title_has');
  if ((e.title_forbid ?? []).some((w) => title.includes(normTitle(w)))) wrong.push('title_forbid');
  // 项目：随手记不评；期望为空的必须为空（不许编项目）
  if (e.kind !== 'note' && (e.project ?? null) !== (a['project'] ?? null)) wrong.push('project');
  if ((e.important === true) !== (a['important'] === true)) wrong.push('important');
  if (e.kind === 'anniv') {
    const x = a['anniv'];
    const w = e.anniv;
    if (!(isObj(x) && w && x['type'] === w.type && x['calendar'] === w.calendar && x['month'] === w.month && x['day'] === w.day && x['is_leap'] === w.is_leap && (x['year'] ?? null) === w.year)) wrong.push('anniv');
  }
  // short：日程、待办只查格式（1–2 个字形簇或 null）；随手记、纪念日必须为 null
  const s = a['short'] ?? null;
  if (timed(a['kind']) ? !(s === null || (typeof s === 'string' && graphemes(s) >= 1 && graphemes(s) <= 2)) : s !== null) wrong.push('short');
  return { wrong: [...new Set(wrong)], date: { on: dateOn, ok: dateOk, madeUp: dateMadeUp }, time: { on: timeOn, ok: timeOk, madeUp: timeMadeUp }, basis };
}

/** 原始输出里带了表示重复的键（不在白名单里的 repeat、rrule、recurrence 等，句库 4.1 最后一行） */
export function rawHasRepeat(raw: unknown): boolean {
  const walk = (v: unknown): boolean =>
    Array.isArray(v) ? v.some(walk) : isObj(v) ? Object.entries(v).some(([k, x]) => /repeat|rrule|recur/i.test(k) || walk(x)) : false;
  return walk(raw);
}

export interface RowJudge {
  id: string;
  group: string;
  scored: SetRow['scored'];
  /**
   * ok：整句对；wrong：答错（含 invalid 整份退回）；missing：没跑到（额度停下、跳过）；
   * nooutput：调了但没拿到模型输出（quota、timeout、error）——不算 AI 答错，记进 problems、结论未定（代码审必改 1）。
   * 后两种在计数里都不算对（分子不加），所以结论只会是“未定”，不会因此“通过”
   */
  status: 'ok' | 'wrong' | 'missing' | 'nooutput';
  /** 失败原因（quota、timeout、invalid、error）和 invalid_reasons；条数不对写 count */
  why: string[];
  /** 第一遍答错的句子补跑的结果（句库 4.2、5.3 第 4 项）：stable 补跑够 3 次且都错；flaky 补跑里对过；unknown 补跑不够 3 次；其他为 null */
  stability: 'stable' | 'flaky' | 'unknown' | null;
  retries: { tries: number; wrong: number } | null;
  items: ItemJudge[];
  multi: boolean;
  countOk: boolean;
  /** 单件事被拆成多条 */
  split: boolean;
  /** 校验通过、期望带 confirm 却没带（规则句“该问没问”） */
  unasked: boolean;
  /** 重复说法拆成多条或记成重复 */
  repeatBad: boolean;
}

export function judgeRow(row: SetRow, res: RunResult | undefined): RowJudge {
  const base = { id: row.id, group: row.group, scored: row.scored, multi: row.expect.length > 1, stability: null, retries: null };
  const none = () => row.expect.map((e) => judgeItem(e, null, row));
  if (!res) return { ...base, status: 'missing', why: ['not_run'], items: none(), countOk: false, split: false, unasked: false, repeatBad: false };
  const rawItems = itemsOf(res.raw);
  const repeatBad = REPEAT_IDS.includes(row.id) && (rawHasRepeat(res.raw) || (rawItems?.length ?? 0) > 1);
  const why = res.ok ? [] : [res.reason ?? 'error', ...(res.invalid_reasons ?? [])];
  if (!res.ok && res.reason !== 'invalid') return { ...base, status: 'nooutput', why, items: none(), countOk: false, split: false, unasked: false, repeatBad };
  // 月份本来没有的观察句：bad_date 整份退回才算对（句库 2.6 O05、O06、O08），收下了、别的原因退回都算错
  if (row.expect_invalid_date) {
    const ok = !res.ok && (res.invalid_reasons ?? []).includes('bad_date');
    return { ...base, status: ok ? 'ok' : 'wrong', why: res.ok ? ['not_rejected'] : why, items: [], countOk: ok, split: false, unasked: false, repeatBad };
  }
  if (!res.ok) return { ...base, status: 'wrong', why, items: none(), countOk: false, split: false, unasked: false, repeatBad };
  const got = itemsOf(res.checked) ?? [];
  const items = row.expect.map((e, i) => judgeItem(e, got[i] ?? null, row));
  const countOk = got.length === row.expect.length;
  const unasked = row.expect.some((e, i) => timed(e.kind) && (e.confirm ?? null) !== null && got[i] !== undefined && (got[i]?.['confirm'] ?? null) === null);
  const allOk = countOk && items.every((x) => x.wrong.length === 0);
  return {
    ...base, status: allOk ? 'ok' : 'wrong', why: countOk ? [] : ['count'], items, countOk,
    split: row.expect.length === 1 && got.length > 1, unasked, repeatBad: repeatBad || (REPEAT_IDS.includes(row.id) && got.length > 1),
  };
}

export type Status = 'pass' | 'fail' | 'pending' | 'na';
export interface Check { key: string; label: string; got: string; need: string; status: Status; ids?: string[] }
/** 上一次的判分结果里用到的部分（基线） */
export interface Baseline { set_versions: string[]; rows: { id: string; status: RowJudge['status'] }[] }
export interface Score {
  name: string;
  set_versions: string[];
  verdict: 'pass' | 'fail' | 'undecided';
  /** 让结论只能是“未定”的问题：句库和结果对不上、有句子没跑到等 */
  problems: string[];
  checks: Check[];
  stats: Record<string, unknown>;
  rows: RowJudge[];
}

const ratio = (n: number, d: number) => (d === 0 ? '—' : `${n}/${d}（${((n / d) * 100).toFixed(1)}%）`);

/**
 * 判一整轮：rows 是句库全部句子，run 是第一遍的结果；baseline、retries 可选（“不比上一次差”一项要用）。
 * retries 是补跑的结果（每份是一次 run.ts 的落盘），同一句出现几次算补跑几次。
 */
export function scoreRun(rows: readonly SetRow[], run: RunReport, opt: { baseline?: Baseline; retries?: readonly RunReport[] } = {}): Score {
  const problems: string[] = [];
  const byId = new Map(run.results.map((r) => [r.id, r]));
  const ids = new Set(rows.map((r) => r.id));
  const setVersions = [...new Set(rows.map((r) => r.set_version))].sort();
  if (JSON.stringify([...run.meta.set_versions].sort()) !== JSON.stringify(setVersions)) problems.push(`结果的句库版本 ${run.meta.set_versions.join('、')} 和现在的句库 ${setVersions.join('、')} 不一样`);
  const extra = run.results.filter((r) => !ids.has(r.id)).map((r) => r.id);
  if (extra.length > 0) problems.push(`结果里有句库没有的句子：${extra.join('、')}`);
  const judged = rows.map((r) => judgeRow(r, byId.get(r.id)));
  // 补跑必须和第一遍是同一模型、同一提示词、同一句库（代码审复查建议 1）；对不上的那份补跑不算数，结论未定
  const sameRun = (r: RunReport) => r.meta.model === run.meta.model && r.meta.prompt === run.meta.prompt
    && JSON.stringify([...r.meta.set_versions].sort()) === JSON.stringify([...run.meta.set_versions].sort());
  const badRetries = (opt.retries ?? []).filter((r) => !sameRun(r));
  if (badRetries.length > 0) {
    problems.push(`补跑结果和第一遍的模型、提示词或句库版本不一样，这几份补跑不算数：${badRetries.map((r) => `${r.meta.name}（${r.meta.model ?? '?'}、${r.meta.prompt ?? '?'}、${r.meta.set_versions.join('、')}）`).join('；')}`);
  }
  markStability(rows, judged, (opt.retries ?? []).filter(sameRun));
  // 观察句不计分，没跑到、没拿到输出只在统计里列，不让结论未定
  const missing = judged.filter((j) => j.status === 'missing' && j.scored !== 'observe').map((j) => j.id);
  if (missing.length > 0) problems.push(`${missing.length} 句没跑到（${run.stopped ?? '跳过'}）：${missing.join('、')}`);
  const noOut = judged.filter((j) => j.status === 'nooutput' && j.scored !== 'observe');
  if (noOut.length > 0) problems.push(`${noOut.length} 句没拿到模型输出（不算答错，要重跑）：${noOut.map((j) => `${j.id}（${j.why[0]}）`).join('、')}`);
  // 重复说法的 6 个 id 必须都是规则句（代码审必改 4）：句库改了编号，“重复说法拆开或记成重复”一项会悄悄漏查
  const ruleIds = new Set(rows.filter((r) => r.scored === 'rule').map((r) => r.id));
  const lostRepeat = REPEAT_IDS.filter((id) => !ruleIds.has(id));
  if (lostRepeat.length > 0) problems.push(`重复说法的句子不在规则句里：${lostRepeat.join('、')}（句库改了编号要同步 REPEAT_IDS）`);

  const of = (pred: (j: RowJudge) => boolean) => judged.filter(pred);
  const okIds = (js: RowJudge[]) => js.filter((j) => j.status === 'ok').length;
  const wrongIds = (js: RowJudge[]) => js.filter((j) => j.status !== 'ok').map((j) => j.id);
  // 没跑到、没拿到输出的句子对错未知（代码审复查建议 2）：把它们全算对也过不了才是“没过”，全算错也过得了才是“过”，其余“未定”
  const unknown = (j: RowJudge) => j.status === 'missing' || j.status === 'nooutput';
  const unk = (js: RowJudge[]) => js.filter(unknown).length;
  const tri = (sure: boolean, fail: boolean): Status => (fail ? 'fail' : sure ? 'pass' : 'pending');
  const unkNote = (n: number) => (n > 0 ? `；另有 ${n} 句没拿到输出，对错未知` : '');
  const checks: Check[] = [];

  // ① 三组各自、② 整体（只算 main，不含规则句、观察句、负责人句）
  const groupSt: Status[] = [];
  let total = 0;
  let totalUnk = 0;
  for (const g of LANG_GROUPS) {
    const js = of((j) => j.group === g && j.scored === 'main');
    if (js.length !== GATE.groupSize) problems.push(`${g} 组计分句是 ${js.length} 句，不是 ${GATE.groupSize} 句`);
    const n = okIds(js);
    const u = unk(js);
    total += n;
    totalUnk += u;
    const s = tri(n >= GATE.group[g], n + u < GATE.group[g]);
    groupSt.push(s);
    checks.push({ key: `group_${g}`, label: `${g} 组`, got: `${n}/${js.length}${unkNote(u)}`, need: `至少 ${GATE.group[g]}/${GATE.groupSize}`, status: s, ids: wrongIds(js) });
  }
  checks.push({
    key: 'total', label: '整体（三组 120 句）', got: `${total}/${GATE.groupSize * 3}${unkNote(totalUnk)}`, need: `至少 ${GATE.total}，且三组各自过线`,
    status: tri(total >= GATE.total && groupSt.every((s) => s === 'pass'), total + totalUnk < GATE.total || groupSt.includes('fail')),
  });
  // ③ 负责人句：90% 向上取整（R-194：13 句对 12）
  const owner = of((j) => j.group === OWNER && j.scored === 'main');
  if (owner.length !== GATE.ownerSize) problems.push(`负责人计分句是 ${owner.length} 句，不是 ${GATE.ownerSize} 句`);
  const ownerNeed = Math.ceil(owner.length * GATE.ownerRate);
  // 句库第 3 节：负责人逐句确认后才计分。有一句没确认（owner_confirmed 不是 true），这一项只能是未定
  const unconfirmed = rows.filter((r) => r.group === OWNER && r.scored === 'main' && !r.owner_confirmed).map((r) => r.id);
  const ownerSt = tri(owner.length > 0 && okIds(owner) >= ownerNeed, okIds(owner) + unk(owner) < ownerNeed);
  checks.push({
    key: 'owner', label: '负责人真实说法',
    got: `${okIds(owner)}/${owner.length}${unkNote(unk(owner))}${unconfirmed.length > 0 ? `；${unconfirmed.length} 句负责人还没确认期望（owner_confirmed 不是 true），确认后才计分：${unconfirmed.join('、')}` : ''}`,
    need: `至少 ${ownerNeed}（90% 向上取整），13 句都经负责人确认`, status: unconfirmed.length > 0 ? 'pending' : ownerSt, ids: wrongIds(owner),
  });

  // ④ 日期、⑤ 时间：三组计分句 + 负责人句里要评的条目
  const scope = of((j) => j.scored === 'main' && ([...LANG_GROUPS, OWNER] as string[]).includes(j.group));
  for (const f of ['date', 'time'] as const) {
    const on = scope.flatMap((j) => j.items.map((it) => ({ id: j.id, x: it[f], u: unknown(j) }))).filter((v) => v.x.on);
    const ok = on.filter((v) => v.x.ok).length;
    const u = on.filter((v) => v.u).length;
    const madeUp = on.filter((v) => v.x.madeUp).map((v) => v.id);
    const rate = f === 'date' ? GATE.dateRate : GATE.timeRate;
    const max = f === 'date' ? GATE.dateMadeUpMax : GATE.timeMadeUpMax;
    // 没拿到输出的条目可能对也可能编了：全算对仍不够 97% 或已编超才算没过
    const sure = on.length > 0 && u === 0 && ok / on.length >= rate && madeUp.length <= max;
    const fail = on.length === 0 || (ok + u) / on.length < rate || madeUp.length > max;
    checks.push({
      key: f, label: f === 'date' ? '关键字段：日期' : '关键字段：时间', got: `${ratio(ok, on.length)}，编了 ${madeUp.length} 条${u > 0 ? `；另有 ${u} 条没拿到输出，对错未知` : ''}`,
      need: `≥ ${rate * 100}%，编${f === 'date' ? '日子' : '时间'}最多 ${max} 条`, status: tri(sure, fail), ids: [...new Set([...on.filter((v) => !v.x.ok).map((v) => v.id), ...madeUp])],
    });
  }
  // ⑥ 拆分条数
  const multi = scope.filter((j) => j.multi);
  if (multi.length !== GATE.multiSize) problems.push(`多件事的句子是 ${multi.length} 句，不是 ${GATE.multiSize} 句（13 句加负责人 R30，句库 4.1）`);
  const multiOk = multi.filter((j) => j.countOk).length;
  const split = scope.filter((j) => j.split).map((j) => j.id);
  const multiUnk = unk(multi);
  const singleUnk = scope.filter((j) => !j.multi && unknown(j)).length;
  checks.push({
    key: 'split', label: '拆分条数', got: `多件事条数全对 ${multiOk}/${multi.length}，单件事拆成多条 ${split.length} 句${unkNote(multiUnk + singleUnk)}`,
    need: `多件事至少 ${GATE.multiOkMin}，单件事拆开最多 ${GATE.singleSplitMax}`,
    status: tri(multiOk >= GATE.multiOkMin && split.length + singleUnk <= GATE.singleSplitMax, multiOk + multiUnk < GATE.multiOkMin || split.length > GATE.singleSplitMax),
    ids: [...multi.filter((j) => !j.countOk).map((j) => j.id), ...split],
  });
  // ⑦ 不比上一次差（按句子比；全库 = 三组计分句 + 负责人句 + 规则句，不含观察句）
  checks.push(regressCheck(rows, judged, opt));
  // ⑧ 规则句（R-175）
  const rule = of((j) => j.scored === 'rule');
  if (rule.length !== GATE.ruleSize) problems.push(`规则句是 ${rule.length} 句，不是 ${GATE.ruleSize} 句`);
  const unasked = rule.filter((j) => j.unasked).map((j) => j.id);
  const repeatBad = rule.filter((j) => j.repeatBad).map((j) => j.id);
  checks.push({
    key: 'rule', label: '规则句', got: `${okIds(rule)}/${rule.length}，该问没问 ${unasked.length}，重复说法拆开或记成重复 ${repeatBad.length}${unkNote(unk(rule))}`,
    need: `至少 ${GATE.ruleOk}/${GATE.ruleSize}，后两项都是 0`,
    status: tri(okIds(rule) >= GATE.ruleOk && unk(rule) === 0 && unasked.length === 0 && repeatBad.length === 0, okIds(rule) + unk(rule) < GATE.ruleOk || unasked.length > 0 || repeatBad.length > 0),
    ids: [...new Set([...wrongIds(rule), ...unasked, ...repeatBad])],
  });
  // 不在这里判的两项：照列，不进结论
  checks.push({ key: 'local', label: 'B 路本机规则（有把握却错最多 2 句）', got: '不在本工作流', need: 'Vitest 里跑（句库 5.2 末条）', status: 'na' });
  checks.push({ key: 'intent', label: 'intent', got: 'B3 不评', need: 'B4b-3 起 0 句', status: 'na' });

  const st = checks.map((c) => c.status);
  const verdict: Score['verdict'] = problems.length > 0 ? 'undecided' : st.includes('fail') ? 'fail' : st.includes('pending') ? 'undecided' : 'pass';
  return { name: run.meta.name, set_versions: setVersions, verdict, problems, checks, stats: statsOf(rows, judged, byId), rows: judged };
}

/**
 * 第一遍答错的句子按补跑结果标稳定错 / 偶尔错（句库 4.2“跑一遍定输赢”、5.3 第 4 项）：补跑里对过一次就是偶尔错；
 * 拿到输出的补跑够 3 次且都错是稳定错；不够 3 次是 unknown。补跑没拿到输出（quota、timeout、error）的那一次不算数
 */
function markStability(rows: readonly SetRow[], judged: RowJudge[], retries: readonly RunReport[]): void {
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  for (const j of judged) {
    const row = rowOf.get(j.id);
    if (j.status !== 'wrong' || !row) continue;
    const tries = retries.flatMap((r) => r.results.filter((x) => x.id === j.id)).map((t) => judgeRow(row, t).status).filter((s) => s === 'ok' || s === 'wrong');
    const wrong = tries.filter((s) => s === 'wrong').length;
    j.retries = { tries: tries.length, wrong };
    j.stability = wrong < tries.length ? 'flaky' : tries.length >= GATE.retryTimes ? 'stable' : 'unknown';
  }
}

function regressCheck(rows: readonly SetRow[], judged: RowJudge[], opt: { baseline?: Baseline }): Check {
  const c = { key: 'regress', label: '不比上一次差', need: `上次对、这次稳定错（第一遍错、补跑 ${GATE.retryTimes} 次都错）的句子最多 ${GATE.regressStableMax} 句` };
  const b = opt.baseline;
  if (!b) return { ...c, got: '没有基线（第一次跑就是基线）', status: 'na' };
  const now = [...new Set(rows.map((r) => r.set_version))].sort();
  if (JSON.stringify([...b.set_versions].sort()) !== JSON.stringify(now)) return { ...c, got: `句库版本不同（基线 ${b.set_versions.join('、')}），要用新句库重跑旧版本定新基线`, status: 'pending' };
  const was = new Map(b.rows.map((r) => [r.id, r.status]));
  // 只看答错的（没跑到、没拿到输出的已经让结论未定）；稳定错 / 偶尔错由 markStability 按补跑结果标好
  const turned = judged.filter((j) => j.scored !== 'observe' && j.status === 'wrong' && was.get(j.id) === 'ok');
  const stable = turned.filter((j) => j.stability === 'stable').map((j) => j.id);
  const unsure = turned.filter((j) => j.stability === 'unknown').map((j) => j.id);
  const ids = [...stable, ...unsure];
  if (stable.length > GATE.regressStableMax) return { ...c, got: `稳定错 ${stable.length} 句`, status: 'fail', ids };
  if (stable.length + unsure.length > GATE.regressStableMax) return { ...c, got: `稳定错 ${stable.length} 句，还有 ${unsure.length} 句没补跑够 ${GATE.retryTimes} 次`, status: 'pending', ids };
  return { ...c, got: `上次对这次错 ${turned.length} 句，其中稳定错 ${stable.length} 句`, status: 'pass', ids };
}

/** 5.3 第 2 条里不计分、只统计的几项 */
function statsOf(rows: readonly SetRow[], judged: RowJudge[], byId: Map<string, RunResult>): Record<string, unknown> {
  const reasons: Record<string, number> = {};
  for (const r of byId.values()) {
    if (r.ok) continue;
    const ks = r.reason === 'invalid' ? (r.invalid_reasons ?? ['invalid']) : [r.reason ?? 'error'];
    for (const k of new Set(ks)) reasons[k] = (reasons[k] ?? 0) + 1;
  }
  // 分母：第一遍拿到模型输出的句子（排除 quota、timeout、error 等没拿到输出的）；观察句单列（句库 5.3、0.29 续第 58 条）
  const buckets: [string, (r: SetRow) => boolean][] = [
    ['全库', (r) => r.scored !== 'observe'],
    ...LANG_GROUPS.map((g): [string, (r: SetRow) => boolean] => [g, (r) => r.group === g && r.scored !== 'observe']),
    ['负责人', (r) => r.group === OWNER && r.scored !== 'observe'],
    ['观察句', (r) => r.scored === 'observe'],
  ];
  const share = (hit: (res: RunResult) => boolean) =>
    Object.fromEntries(buckets.map(([name, pick]) => {
      const got = rows.filter(pick).map((r) => byId.get(r.id)).filter((x): x is RunResult => x !== undefined && x.raw !== null);
      return [name, ratio(got.filter(hit).length, got.length)];
    }));
  const rawItems = (r: RunResult) => itemsOf(r.raw) ?? [];
  const count = (hit: (it: Item) => boolean) => [...byId.values()].filter((r) => rawItems(r).some(hit)).length;
  return {
    invalid_reasons: reasons,
    missing_date_basis: share((r) => (r.invalid_reasons ?? []).includes('missing_date_basis')),
    todo_time_without_due: share((r) => rawItems(r).some((it) => it['kind'] === 'todo' && typeof it['time'] === 'string' && (it['due'] ?? null) === null)),
    main_basis_mismatch: judged.filter((j) => j.scored === 'main' && j.items.some((x) => x.basis === false)).map((j) => j.id),
    raw_anniv_with_date_or_due: count((it) => it['kind'] === 'anniv' && ((it['date'] ?? null) !== null || (it['due'] ?? null) !== null)),
    raw_event_due_or_todo_date: count((it) => (it['kind'] === 'event' && (it['due'] ?? null) !== null) || (it['kind'] === 'todo' && (it['date'] ?? null) !== null)),
    raw_note_or_anniv_short: count((it) => (it['kind'] === 'note' || it['kind'] === 'anniv') && (it['short'] ?? null) !== null),
    observe: judged.filter((j) => j.scored === 'observe').map((j) => ({ id: j.id, status: j.status, why: j.why, wrong: [...new Set(j.items.flatMap((x) => x.wrong))] })),
  };
}

const MARK: Record<Status, string> = { pass: '过', fail: '没过', pending: '未定', na: '不适用' };
const VERDICT: Record<Score['verdict'], string> = { pass: '通过', fail: '不通过', undecided: '未定' };
const STATUS: Record<RowJudge['status'], string> = { ok: '对', wrong: '错', missing: '没跑到', nooutput: '没拿到输出' };
/** 观察句不说“对 / 错”，只说和预期一样不一样（月份本来没有的 O05、O06、O08，bad_date 整份退回就是“符合预期”） */
const OBSERVE: Record<RowJudge['status'], string> = { ok: '符合预期', wrong: '和预期不同', missing: '没跑到', nooutput: '没拿到输出' };
/** 错的字段：只有答错的句子才列（没跑到、没拿到输出的没有可比的结果） */
const fieldsOf = (r: RowJudge): string => (r.status === 'wrong' ? [...new Set(r.items.flatMap((x) => x.wrong))].join('、') || '—' : '—');
const stab = (r: RowJudge): string => {
  if (r.status !== 'wrong') return '—';
  const t = r.retries && r.retries.tries > 0 ? `（补跑 ${r.retries.tries} 次错 ${r.retries.wrong} 次）` : '（没补跑）';
  return `${r.stability === 'stable' ? '稳定错' : r.stability === 'flaky' ? '偶尔错' : '未定'}${t}`;
};

/** 摘要（工作流摘要页和产物里各一份）：只有 id、字段名和数字 */
export function toMarkdown(s: Score): string {
  const lines = [
    `# 测试集 ① 判分：${s.name}`, '',
    `- 句库版本：${s.set_versions.join('、')}`,
    `- 结论（A 路门槛，只按第一遍）：**${VERDICT[s.verdict]}**`,
    ...s.problems.map((p) => `- 未定原因：${p}`), '',
    '| 项目 | 结果 | 门槛 | 判定 | 涉及的句子 |', '|---|---|---|---|---|',
    ...s.checks.map((c) => `| ${c.label} | ${c.got} | ${c.need} | ${MARK[c.status]} | ${(c.ids ?? []).join('、') || '—'} |`), '',
    '- 整份退回（invalid）的句子，这句的条目在日期、时间两项的分母里都按错算；没拿到输出（quota、timeout、error）、没跑到的不算答错，结论未定、要重跑', '',
    '## 错的句子（第一遍；补跑 3 次分稳定错 / 偶尔错，句库 5.3 第 4 项）', '',
    '| id | 组 | 计分 | 原因 | 错的字段 | 补跑 |', '|---|---|---|---|---|---|',
    ...s.rows.filter((r) => r.status !== 'ok' && r.scored !== 'observe')
      .map((r) => `| ${r.id} | ${r.group} | ${r.scored} | ${r.status === 'wrong' ? '' : `${STATUS[r.status]}：`}${r.why.join('、') || '—'} | ${fieldsOf(r)} | ${stab(r)} |`), '',
    '## 观察句（不计分，只报告）', '',
    '| id | 组 | 和预期比 | 原因 | 不一样的字段 |', '|---|---|---|---|---|',
    ...s.rows.filter((r) => r.scored === 'observe')
      .map((r) => `| ${r.id} | ${r.group} | ${OBSERVE[r.status]} | ${r.why.join('、') || '—'} | ${fieldsOf(r)} |`), '',
    '## 统计（不计分）', '',
    '```json', JSON.stringify(s.stats, null, 2), '```', '',
  ];
  return `${lines.join('\n')}\n`;
}
