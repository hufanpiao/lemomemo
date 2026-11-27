// 测试集 ① 判分入口（Deno；B3 任务单 S19、第四节 tests/ai/score.ts 一行；AI 句库 4.1、5.3）。判法全在 score-core.ts（有单测），这里只读写文件。
// 用法（评测工作流 ai-eval.yml 在 run.ts 之后调；本机也能对回放结果跑）：
//   deno run --frozen --allow-read --allow-write=<--run 文件所在的目录> tests/ai/score.ts --run <目录>/<名>.json
//     [--baseline <上一次的 <名>.score.json>] [--retry <run.ts --only 补跑的结果 .json>]...（--retry 可写多次，补跑几次写几个）
//   工作流里 <目录> 就是 tests/ai/reports；本机对回放结果跑时是 run.ts 打印的系统临时目录。
// 产物：写在 --run 文件旁边（只写这两个文件）：<名>.score.json（每句对错、稳定错 / 偶尔错、4.1 各项）和 <名>.score.md（摘要，只有 id 和数字）。
// 读句库时同时过 run-core.ts 的 parseSet（调用要用的字段、跨文件 id 不许重复）和 score-core.ts 的 parseExpect（期望的白名单）。
// 退出码：0 通过；10 不通过；11 未定（句库和结果对不上、有句子没跑到、补跑不够）；1 参数或文件出错。
// 正式报告 docs/06-测试/AI回归/<名>.md 仍由评测员写（句库 5.3），这里出的是判分底稿。
// 函数部署时没有这个文件；它在 tsconfig.node.json 之外，由 deno task check 检查。
import { parseSet } from './run-core.ts';
import { parseExpect, scoreRun, toMarkdown, type Baseline, type RunReport, type SetRow } from './score-core.ts';

const ROOT = new URL('../../', import.meta.url);

function parseArgs(argv: readonly string[]): { run: string; baseline: string | null; retries: string[] } {
  let run: string | null = null;
  let baseline: string | null = null;
  const retries: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i] ?? '';
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${k} 缺值`);
    if (k === '--run' && run === null) run = v;
    else if (k === '--baseline' && baseline === null) baseline = v;
    else if (k === '--retry') retries.push(v);
    else throw new Error(`不认的参数或写了两次：${k}`);
  }
  if (run === null) throw new Error('--run 必填（run.ts 落盘的结果 JSON）');
  return { run, baseline, retries };
}

async function readRows(): Promise<SetRow[]> {
  const dir = new URL('tests/ai/set1/', ROOT);
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith('.jsonl')) names.push(e.name);
  } catch {
    throw new Error('没有 tests/ai/set1/（句库还没转成 jsonl，句库 2.5）');
  }
  if (names.length === 0) throw new Error('tests/ai/set1/ 里没有 .jsonl');
  const rows: SetRow[] = [];
  const seen = new Set<string>();
  for (const n of names.sort()) {
    const text = await Deno.readTextFile(new URL(n, dir));
    parseSet(n, text, seen);
    rows.push(...parseExpect(n, text));
  }
  return rows;
}

const readJson = async <T>(p: string): Promise<T> => JSON.parse(await Deno.readTextFile(p)) as T;

async function main(): Promise<number> {
  const a = parseArgs(Deno.args);
  if (!a.run.endsWith('.json') || a.run.endsWith('.score.json')) throw new Error('--run 要的是 run.ts 的结果 .json，不是判分结果');
  const rows = await readRows();
  const run = await readJson<RunReport>(a.run);
  const retries = await Promise.all(a.retries.map((p) => readJson<RunReport>(p)));
  const s = scoreRun(rows, run, a.baseline === null ? { retries } : { baseline: await readJson<Baseline>(a.baseline), retries });
  const stem = a.run.slice(0, -'.json'.length);
  await Deno.writeTextFile(`${stem}.score.json`, `${JSON.stringify(s, null, 2)}\n`);
  await Deno.writeTextFile(`${stem}.score.md`, toMarkdown(s));
  console.log(`判分：${s.verdict}（${stem}.score.md）`);
  return s.verdict === 'pass' ? 0 : s.verdict === 'fail' ? 10 : 11;
}

if (import.meta.main) {
  main().then(
    (code) => Deno.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    },
  );
}
