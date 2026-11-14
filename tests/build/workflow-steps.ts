// tests/build 里几份工作流测试共用的“按任务、按步骤切 GitHub Actions 工作流”（11-14 构建与架构检查整块评审：原来
// vapid-public-key-check、workflow-permissions、deno-frozen-lock、ci-guard-scripts 各写一份切法）。按文本逐行切，不依赖 YAML 解析库。
// 任务：jobs: 下面缩进 2 格的键；步骤：任务的 steps: 下面同一缩进的“- ”项，name 不是第一个键也认（- if: … 后面才写 name:）。
// 步骤在下一个同缩进的“- ”、缩进不超过它的非空行（注释、下一个任务）处结束；空行不打断。

export interface Step {
  /** 所在任务的键名 */
  job: string;
  /** 这一步的各行（原样，含开头的“- ”） */
  lines: string[];
  /** lines 用换行拼起来 */
  text: string;
  /** name: 的值（没有为空串） */
  name: string;
  /** if: 的值（没有为空串） */
  cond: string;
  /** 这一步的顶层键所在的行（开头的“- ”换成两个空格后，缩进等于步骤缩进 + 2 的行，去掉首尾空白） */
  keys: string[];
  /** 第一行在整个文件里的行号（从 0 数） */
  start: number;
}

const indentOf = (l: string) => l.length - l.trimStart().length;

export function workflowSteps(yml: string): Step[] {
  const all = yml.split(/\r?\n/);
  const out: Step[] = [];
  let inJobs = false;
  let job = '';
  let stepsIndent = -1; // 当前 steps: 的缩进；-1 表示不在 steps 块里
  let itemIndent = -1; // steps 下“- ”项的缩进
  let cur: Step | null = null;
  const close = () => {
    if (!cur) return;
    while (cur.lines.length && cur.lines.at(-1)?.trim() === '') cur.lines.pop();
    cur.text = cur.lines.join('\n');
    const body = cur.lines.map((l, i) => (i === 0 ? l.replace(/^(\s*)- /, '$1  ') : l));
    cur.keys = body.filter((l) => l.trim() && indentOf(l) === itemIndent + 2).map((l) => l.trim());
    const key = (k: string) => cur?.keys.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim() ?? '';
    cur.name = key('name');
    cur.cond = key('if');
    out.push(cur);
    cur = null;
  };
  all.forEach((line, i) => {
    const ind = indentOf(line);
    const blank = line.trim() === '';
    if (/^jobs:\s*$/.test(line)) {
      close();
      inJobs = true;
      return;
    }
    if (!blank && ind === 0) {
      close();
      inJobs = false;
      stepsIndent = -1;
      return;
    }
    if (inJobs && ind === 2 && /^ {2}[^\s#][^:]*:\s*$/.test(line)) {
      close();
      job = line.trim().slice(0, -1);
      stepsIndent = -1;
      return;
    }
    if (cur && !blank && ind <= itemIndent && !(ind === itemIndent && /^\s*- /.test(line))) close();
    if (stepsIndent >= 0 && !blank && ind <= stepsIndent) stepsIndent = -1;
    if (/^\s*steps:\s*$/.test(line)) {
      close();
      stepsIndent = ind;
      itemIndent = -1;
      return;
    }
    if (stepsIndent >= 0 && /^\s*- /.test(line) && (itemIndent < 0 || ind === itemIndent) && ind > stepsIndent) {
      close();
      itemIndent = ind;
      cur = { job, lines: [line], text: '', name: '', cond: '', keys: [], start: i };
      return;
    }
    if (cur) cur.lines.push(line);
  });
  close();
  return out;
}

/** 名字以 prefix 开头的第一步和它在 steps 里的下标（没有时 step 为 undefined、index 为 -1） */
export function stepNamed(steps: Step[], prefix: string): { step: Step | undefined; index: number } {
  const index = steps.findIndex((s) => s.name.startsWith(prefix));
  return { step: steps[index], index };
}

/** 这一步 run: 的命令：同一行的值，或 run: | 块里的各行（去掉块的缩进） */
export function runOf(step: Step): string {
  const at = step.lines.findIndex((l) => /^\s*(?:- )?run:/.test(l));
  if (at < 0) return '';
  const head = (step.lines[at] ?? '').replace(/^\s*(?:- )?run:\s*/, '');
  if (!/^[|>][-+]?\s*$/.test(head)) return head;
  const body = step.lines.slice(at + 1);
  const ind = Math.min(...body.filter((l) => l.trim()).map(indentOf));
  return body.map((l) => l.slice(ind)).join('\n').trimEnd();
}
