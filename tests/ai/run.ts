// 测试集 ① 评测程序（Deno；B3 任务单 BE-1“tests/ai/run.ts 骨架”；AI 句库 5.2、5.3；架构 0.29 第 13 条、2.5）。骨架：只调用、落盘，不评分。
// 主流程和顺序在 run-core.ts 的 runEval（有单测）：参数 → 真调用先查密钥 → 算好报告名 → 复制步骤（和部署同一个：npm run copy:shared
// 的 node build/copy_shared.mjs）→ 读 tests/ai/set1/*.jsonl（句库 2.5）→ import 正式的 parse-with-ai.ts、传入 gemini.ts 的 provider
// → 按额度上限的 80% 逐句调 → 每句的原始输出和校验后结果写成 JSON。这里只接 Deno 的真动作。
// 用法：
//   只用回放桩（不联网、不用密钥，结果写进系统临时目录、不进仓库）：
//     deno run --allow-read --allow-write=supabase/functions/_shared/gen,<系统临时目录> --allow-run=node --allow-env=PATH,SYSTEMROOT tests/ai/run.ts --replay parse-ok --rpm 60 --rpd 1000 --date 2026-11-20
//     （<系统临时目录>：PowerShell 写 "$env:TEMP"，Git Bash 写 "$(cygpath -w "$TEMP")"，Linux / macOS 写 "${TMPDIR:-/tmp}"）
//   真调用（只在手动触发的评测工作流里跑；密钥由工作流从 GitHub secret 放进环境变量 GEMINI_EVAL_KEY，本机不放、不经过 AI，句库 5.2）：
//     deno run --allow-read --allow-write=tests/ai/reports,supabase/functions/_shared/gen --allow-run=node --allow-env=GEMINI_EVAL_KEY,PATH,SYSTEMROOT
//       --allow-net=generativelanguage.googleapis.com tests/ai/run.ts --model <Q6 选定的模型> --rpm <截图上限> --rpd <截图上限> --date <YYYY-MM-DD>
//   **每天上限只按本次运行计**：同一天同一模型跑第二次，--rpd 要自己扣掉上一次已调的句数（结果 JSON 的 meta.called），否则合计会超过 80%（代码审 S2）。
//   只跑指定的句子（S19“不比上一次差”的补跑；回放、真调用都能用）：上面任一条命令后面加 --only Z10,K10,M10
//     id 句库里没有就报错退出、一句都不调；结果名是 only-set1-<日期>-<提示词版本>-<模型名>-t<UTC 时分秒毫秒>.json，
//     不覆盖第一遍，也不匹配 set1-*.json；补跑也算进每天上限（--rpd 照上一条扣）。
//   结果：tests/ai/reports/set1-<日期>-<提示词版本>-<模型名>.json（句库 5.3）；评分和报告 .md 由评测员写。
//   tests/ai/reports/ 在 .gitignore 里：每句有模型原文和句库原文，仓库公开，不提交，以工作流产物存档（安全审建议 6）。
// 函数部署时没有这个文件；它在 tsconfig.node.json 之外，由 deno task check 检查。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSet, runEval, type EvalDeps, type EvalRow } from './run-core.ts';
import { replayProvider, REPLAY_MODEL } from './replay/replay.ts';
import { GeminiProvider } from '../../supabase/functions/_shared/ai/gemini.ts';
import type { AIProvider } from '../../supabase/functions/_shared/ai/provider.ts';
import type { ParseFail, ParseInput, ParseOk } from '../../supabase/functions/_shared/ai/parse-core.ts';

const ROOT = new URL('../../', import.meta.url);

/** 复制步骤的子进程不继承环境变量（代码审 S3：GEMINI_EVAL_KEY 不进子进程），只给 node 找得到自己要的 PATH、SYSTEMROOT */
async function copyShared(): Promise<void> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'SYSTEMROOT']) {
    const v = Deno.env.get(k);
    if (v !== undefined) env[k] = v;
  }
  const r = await new Deno.Command('node', { args: ['build/copy_shared.mjs'], cwd: ROOT, clearEnv: true, env, stdout: 'inherit', stderr: 'inherit' }).output();
  if (!r.success) throw new Error('复制步骤 build/copy_shared.mjs 失败，不跑评测');
}

async function readRows(): Promise<EvalRow[]> {
  const dir = new URL('tests/ai/set1/', ROOT);
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith('.jsonl')) names.push(e.name);
  } catch {
    throw new Error('没有 tests/ai/set1/（句库还没转成 jsonl，句库 2.5）');
  }
  if (names.length === 0) throw new Error('tests/ai/set1/ 里没有 .jsonl');
  const seen = new Set<string>();
  const rows: EvalRow[] = [];
  for (const n of names.sort()) rows.push(...parseSet(n, await Deno.readTextFile(new URL(n, dir)), seen));
  return rows;
}

const deps: EvalDeps = {
  getKey: () => Deno.env.get('GEMINI_EVAL_KEY'),
  copyShared,
  readRows,
  // 复制完再 import：parse-with-ai.ts 引的是刚生成的 _shared/gen/
  loadParse: async () =>
    ((await import('../../supabase/functions/_shared/ai/parse-with-ai.ts')) as {
      parseWithAI: (input: ParseInput, p: AIProvider) => Promise<ParseOk<unknown> | ParseFail>;
    }).parseWithAI,
  liveProvider: (model, key) => new GeminiProvider(model, key, fetch),
  replayProvider: (name) => ({ provider: replayProvider(name).provider, model: REPLAY_MODEL }),
  async write(where, name, json) {
    const dir = where === 'temp' ? pathToFileURL(`${await Deno.makeTempDir({ prefix: 'lemo-eval-replay-' })}/`) : new URL('tests/ai/reports/', ROOT);
    await Deno.mkdir(dir, { recursive: true });
    const file = new URL(`${name}.json`, dir);
    await Deno.writeTextFile(file, json);
    return fileURLToPath(file);
  },
  clock: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  nowIso: () => new Date().toISOString(),
};

if (import.meta.main) {
  runEval(Deno.args, deps).then(
    (r) => console.log(`评测结果：${r.file}（调用 ${r.called} 句，跳过 ${r.skipped} 句${r.stopped ? `，提前停下：${r.stopped}` : ''}）`),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    },
  );
}
