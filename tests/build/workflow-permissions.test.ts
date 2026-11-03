// 出 exe 和正式产物的两个工作流的权限静态守护（B6-exe 安全审查 S-8）：
// desktop.yml、release-build.yml 顶层 permissions: {}，每个任务都单独写 permissions 且只有 contents: read；
// 不引用 secrets、不 secrets: inherit、不要 id-token、不写仓库、不用 environment，action 一律钉 SHA。
// 按文本逐行检查，不依赖 YAML 解析库（js-yaml 只是间接依赖）；下面另有合成样例证明拦得住。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const FILES = ['.github/workflows/desktop.yml', '.github/workflows/release-build.yml'];

const indentOf = (line: string) => line.length - line.trimStart().length;
/** 去掉注释和空行，保留行号 */
const codeLines = (text: string) =>
  text
    .split('\n')
    .map((raw, i) => ({ no: i + 1, line: raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '').trimEnd() }))
    .filter((x) => x.line.trim() !== '');

function checkWorkflow(text: string): string[] {
  const problems: string[] = [];
  const lines = codeLines(text);

  // ① 禁用的写法（只看代码，不看注释）
  const banned: [RegExp, string][] = [
    [/\bsecrets\./, '引用了 secrets'],
    [/secrets:\s*inherit/, 'secrets: inherit'],
    [/id-token/, '要了 id-token'],
    [/:\s*write\b/, '有写权限'],
    [/write-all|read-all/, '用了 read-all / write-all'],
    [/^\s*environment:/, '用了 environment'],
    [/pull_request_target|workflow_run/, '危险的触发方式'],
  ];
  for (const { no, line } of lines) {
    for (const [re, what] of banned) if (re.test(line)) problems.push(`第 ${no} 行${what}：${line.trim()}`);
    const ref = /^\s*-?\s*uses:\s*(\S+)/.exec(line)?.[1];
    if (ref && !ref.startsWith('./') && !/@[0-9a-f]{40}$/.test(ref)) problems.push(`第 ${no} 行 action 没钉 SHA：${ref}`);
  }

  // ② 顶层 permissions: {}
  const top = lines.filter((x) => indentOf(x.line) === 0 && x.line.startsWith('permissions:'));
  if (top.length !== 1 || top[0]?.line.replace(/\s/g, '') !== 'permissions:{}') problems.push('顶层必须正好一行 permissions: {}');

  // ③ 每个任务都有 permissions，且块里只有 contents: read
  const jobsAt = lines.findIndex((x) => x.line === 'jobs:');
  if (jobsAt < 0) return [...problems, '没有 jobs:'];
  const jobs: { name: string; body: typeof lines }[] = [];
  for (const x of lines.slice(jobsAt + 1)) {
    const ind = indentOf(x.line);
    if (ind === 0) break;
    if (ind === 2) jobs.push({ name: x.line.trim().replace(/:$/, ''), body: [] });
    else jobs.at(-1)?.body.push(x);
  }
  if (jobs.length === 0) problems.push('jobs 下面没有任务');
  for (const job of jobs) {
    const at = job.body.findIndex((x) => indentOf(x.line) === 4 && x.line.trim().startsWith('permissions:'));
    if (at < 0) {
      problems.push(`任务 ${job.name} 没写 permissions`);
      continue;
    }
    const head = job.body[at]?.line.trim() ?? '';
    const block: string[] = [];
    for (const x of job.body.slice(at + 1)) {
      if (indentOf(x.line) <= 4) break;
      block.push(x.line.trim());
    }
    if (head !== 'permissions:' || block.length !== 1 || block[0]?.replace(/\s+/g, ' ') !== 'contents: read') {
      problems.push(`任务 ${job.name} 的 permissions 必须只有 contents: read，现在是：${[head, ...block].join(' / ')}`);
    }
  }
  // 其他位置（比如 steps 里）不该再出现 permissions
  const permLines = lines.filter((x) => /^(?:-\s*)?permissions:/.test(x.line.trim()));
  if (permLines.length !== 1 + jobs.length) problems.push(`permissions 出现 ${permLines.length} 次，应为 ${1 + jobs.length} 次（顶层一次、每个任务一次）`);
  return problems;
}

describe('工作流权限静态守护（desktop.yml、release-build.yml）', () => {
  for (const f of FILES) {
    it(`${f} 只给 contents: read、不碰任何机密`, () => {
      expect(checkWorkflow(readFileSync(join(ROOT, f), 'utf8'))).toEqual([]);
    });
  }

  it('release-build 调 desktop.yml 时只传 release-<tag> 和 production', () => {
    const t = readFileSync(join(ROOT, '.github/workflows/release-build.yml'), 'utf8');
    expect(t).toMatch(/uses: \.\/\.github\/workflows\/desktop\.yml\n {4}with:\n {6}web_artifact: release-\$\{\{ github\.ref_name \}\}\n {6}expect_env: production\n/);
    expect(t).toMatch(/ {2}desktop:\n(?: {4}.*\n)*? {4}needs: build\n/);
  });

  it('desktop.yml 的触发只有预览 tag 和 workflow_call', () => {
    const t = readFileSync(join(ROOT, '.github/workflows/desktop.yml'), 'utf8');
    const on = t.slice(t.indexOf('\non:\n'), t.indexOf('\npermissions:'));
    const triggers = on.split('\n').filter((l) => /^ {2}[^\s#]/.test(l)).map((l) => l.trim());
    expect(triggers).toEqual(['push:', 'workflow_call:']);
    expect(on).toContain("- 'v[0-9]+.[0-9]+.[0-9]+-preview.[0-9]+'");
  });

  const good = `name: x
on:
  push:
    tags: ['v1']
permissions: {}
jobs:
  a:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: echo ok # secrets.X 写在注释里不算
`;
  it('合成样例：合格的通过', () => {
    expect(checkWorkflow(good)).toEqual([]);
  });

  const bad: [string, string, RegExp][] = [
    ['顶层不是 {}', good.replace('permissions: {}', 'permissions:\n  contents: read'), /顶层/],
    ['任务多给权限', good.replace('      contents: read\n', '      contents: read\n      actions: read\n'), /只有 contents: read/],
    ['任务没写 permissions', good.replace('    permissions:\n      contents: read\n', ''), /没写 permissions/],
    ['写权限', good.replace('contents: read', 'contents: write'), /写权限/],
    ['引用 secrets', good.replace('echo ok', 'echo "${{ secrets.TOKEN }}"'), /secrets/],
    ['secrets: inherit', good.replace('    steps:', '    secrets: inherit\n    steps:'), /inherit/],
    ['id-token', good.replace('      contents: read\n', '      contents: read\n      id-token: write\n'), /id-token/],
    ['environment', good.replace('    steps:', '    environment: production\n    steps:'), /environment/],
    ['action 没钉 SHA', good.replace(/@[0-9a-f]{40}/, '@v7'), /钉 SHA/],
    ['步骤里藏 permissions', good.replace('      - run:', '      - permissions: {}\n      - run:'), /出现 3 次/],
  ];
  for (const [name, text, re] of bad) {
    it(`合成样例：${name}会被拦下`, () => {
      expect(checkWorkflow(text).join('\n')).toMatch(re);
    });
  }
});

// upload-artifact 默认不传点开头的文件（include-hidden-files 默认 false），漏了也不报错：
// 每个上传步骤的**上一步（同一任务内）**必须就是对同一个目录的检查：用 find -L 查（upload-artifact 会跟进符号链接）、有就 exit 1、
// 不许 continue-on-error，条件（if）和上传步骤相同；也不许打开 include-hidden-files（工作流隐藏文件审查 M1、建议 1）
type Step = { job: string; text: string; name: string; cond: string };
/** 按任务切开再切步骤：任务是 jobs: 下面缩进 2 格的键，步骤是缩进 6 格的“- ” */
function steps(text: string): Step[] {
  const at = text.search(/^jobs:\s*$/m);
  const body = at >= 0 ? text.slice(at) : text;
  const out: Step[] = [];
  for (const part of body.split(/\n(?= {2}[^\s#][^\n]*:[ \t]*\n)/)) {
    const job = /^ {2}([^\s#][^:\n]*):/.exec(part)?.[1] ?? '';
    for (const s of part.split(/\n(?= {6}- )/).filter((x) => x.startsWith('      - '))) {
      out.push({ job, text: s, name: /- name: (.*)/.exec(s)?.[1] ?? '', cond: /^ {8}if: (.*)$/m.exec(s)?.[1] ?? '' });
    }
  }
  return out;
}
function checkUploads(text: string): string[] {
  const problems: string[] = [];
  const all = steps(text);
  all.forEach((st, i) => {
    if (!/uses: actions\/upload-artifact@/.test(st.text)) return;
    if (/include-hidden-files/.test(st.text)) problems.push(`${st.name}：不要打开 include-hidden-files`);
    const path = /^ {10}path: (\S+?)\/?$/m.exec(st.text)?.[1];
    if (!path) return void problems.push(`${st.name}：没有 path`);
    const g = all[i - 1];
    if (!g || g.job !== st.job || !g.text.includes(`find -L ${path} -name '.*'`)) {
      return void problems.push(`${st.name}：上一步（同一任务内）不是对 ${path} 查点开头文件（find -L）的检查`);
    }
    if (!/^\s*exit 1\s*$/m.test(g.text)) problems.push(`${st.name}：查点开头文件那一步没有 exit 1`);
    if (/continue-on-error/.test(g.text)) problems.push(`${st.name}：查点开头文件那一步不许 continue-on-error`);
    if (g.cond !== st.cond) problems.push(`${st.name}：查点开头文件那一步的条件（${g.cond || '无'}）和上传的（${st.cond || '无'}）不一样`);
  });
  return problems;
}

describe('上传产物前查点开头的文件（upload-artifact 默认不传它们）', () => {
  for (const f of FILES) {
    it(`${f}：每个上传步骤的上一步都是对应的检查`, () => {
      const t = readFileSync(join(ROOT, f), 'utf8');
      expect(steps(t).filter((s) => s.text.includes('upload-artifact@')).length).toBeGreaterThan(0);
      expect(checkUploads(t)).toEqual([]);
    });
  }

  const up = (cond = '') => `      - name: 上传\n${cond ? `        if: ${cond}\n` : ''}        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2\n        with:\n          name: x\n          path: out/\n`;
  const guard = (cond = '', extra = '', exit = true) =>
    `      - name: 查\n${cond ? `        if: ${cond}\n` : ''}${extra}        run: |\n          hidden="$(find -L out -name '.*' -print)"\n          if [ -n "$hidden" ]; then\n${exit ? '            exit 1\n' : '            echo 有\n'}          fi\n`;
  const other = '      - name: 别的\n        run: echo hi\n';
  const job = (name: string, body: string) => `  ${name}:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;
  const wf = (...jobs: string[]) => `name: x\njobs:\n${jobs.join('')}`;
  it('合成样例：上一步是检查、条件相同的通过', () => {
    expect(checkUploads(wf(job('a', guard() + up())))).toEqual([]);
    expect(checkUploads(wf(job('a', guard("a == 'b'") + up("a == 'b'"))))).toEqual([]);
  });
  it('合成样例：缺检查、条件不同、打开 include-hidden-files 的拦下', () => {
    expect(checkUploads(wf(job('a', up()))).join()).toMatch(/不是对 out 查点开头文件/);
    expect(checkUploads(wf(job('a', guard("a == 'b'") + up()))).join()).toMatch(/条件/);
    expect(checkUploads(wf(job('a', `${guard()}${up()}          include-hidden-files: true\n`))).join()).toMatch(/include-hidden-files/);
  });
  it('合成样例：检查和上传中间夹一步、检查在别的任务里、检查没有 exit 1、检查带 continue-on-error 的拦下（M1）', () => {
    expect(checkUploads(wf(job('a', guard() + other + up()))).join()).toMatch(/上一步（同一任务内）不是/);
    expect(checkUploads(wf(job('a', guard()), job('b', up()))).join()).toMatch(/上一步（同一任务内）不是/);
    expect(checkUploads(wf(job('a', guard('', '', false) + up()))).join()).toMatch(/没有 exit 1/);
    expect(checkUploads(wf(job('a', guard('', '        continue-on-error: true\n') + up()))).join()).toMatch(/continue-on-error/);
    // 不带 -L 的老写法也拦下
    expect(checkUploads(wf(job('a', guard().replace('find -L out', 'find out') + up()))).join()).toMatch(/find -L/);
  });
});

// 检查脚本本身的行为（代码审查建议 5）：把 desktop.yml 里查 out 的那一段 run 原样取出来，在临时目录里直接用 bash 跑
const BASH = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => existsSync(p)) : 'bash';
describe.skipIf(!BASH)('查点开头文件的 shell 脚本（在临时目录里真跑）', () => {
  const t = readFileSync(join(ROOT, '.github/workflows/desktop.yml'), 'utf8');
  const st = steps(t).find((s) => s.text.includes("find -L out -name '.*'"));
  const script = (st?.text ?? '')
    .split('\n')
    .slice((st?.text ?? '').split('\n').findIndex((l) => l.trim() === 'run: |') + 1)
    .filter((l) => l.startsWith('          ') || l.trim() === '')
    .map((l) => l.slice(10))
    .join('\n');
  const run = (make: (out: string) => void) => {
    const d = mkdtempSync(join(tmpdir(), 'lemo-hidden-'));
    try {
      writeFileSync(join(d, 'check.sh'), script + '\n');
      make(join(d, 'out'));
      const r = spawnSync(BASH ?? 'bash', ['--noprofile', '--norc', '-eo', 'pipefail', 'check.sh'], { cwd: d, encoding: 'utf8' });
      return { code: r.status, out: r.stdout + r.stderr };
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  it('取到了脚本', () => {
    expect(script).toContain("find -L out -name '.*' -print");
    expect(script).toContain('exit 1');
  });
  it('没有点开头的文件（嵌套、带空格的文件名）：通过', () => {
    const r = run((o) => {
      mkdirSync(join(o, 'a b', 'c'), { recursive: true });
      writeFileSync(join(o, 'a b', 'c', 'x y.exe'), '1');
      writeFileSync(join(o, 'latest.json'), '{}');
    });
    expect(r.code, r.out).toBe(0);
  });
  it('嵌套目录里、带空格的点开头文件：失败，错误注解只写数量，列表在日志里', () => {
    const r = run((o) => {
      mkdirSync(join(o, 'a b', '.cache'), { recursive: true });
      writeFileSync(join(o, 'a b', '.cache', 'k'), '1');
      writeFileSync(join(o, '.x y'), '1');
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::out 里有 2 个点开头的文件或目录');
    expect(r.out).toContain('out/a b/.cache');
    expect(r.out).toContain('out/.x y');
    const err = r.out.split('\n').find((l) => l.startsWith('::error::')) ?? '';
    expect(err).not.toContain('.cache');
  });
  it.skipIf(process.platform === 'win32')('带换行的点开头文件名：按一个算，照样失败', () => {
    const r = run((o) => {
      mkdirSync(o);
      writeFileSync(join(o, '.a\nb'), '1');
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::out 里有 1 个点开头的文件或目录');
  });
  it.skipIf(process.platform === 'win32')('符号链接指向的目录里有点开头的文件：find -L 跟进去，失败', () => {
    const r = run((o) => {
      const real = join(o, '..', 'real');
      mkdirSync(real);
      writeFileSync(join(real, '.secret'), '1');
      mkdirSync(o);
      symlinkSync(real, join(o, 'link'));
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('out/link/.secret');
  });
  it('目录不存在：失败（不放行）', () => {
    const r = run(() => {});
    expect(r.code).not.toBe(0);
  });
});

// 安装包原名的整名核对（工作流隐藏文件审查 M2、安全审查 A-1）：挪进了 desktop_scan.mjs --package（正反例在 desktop-scan.test.ts），
// 这里钉住 desktop.yml 真的调用它、上传用的文件名只从它的输出取，而且排在 cp 之前
describe('desktop.yml 整理产物：安装包名来自 desktop_scan --package', () => {
  it('id: pkg 那一步先核对原名、取文件名，再 cp；yml 里不另拼 lemomemo 前缀', () => {
    const t = readFileSync(join(ROOT, '.github/workflows/desktop.yml'), 'utf8');
    const st = steps(t).find((s) => /^ {8}id: pkg$/m.test(s.text));
    expect(st).toBeDefined();
    const s = st?.text ?? '';
    const a = s.indexOf('name="$(node build/ci/desktop_scan.mjs --env "$LEMO_ENV" --package "$bundle/nsis" --version "$LEMO_VERSION")"');
    const b = s.indexOf('cp "${setups[0]}" "out/$name"');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(s.match(/^\s*name=/gm)?.length).toBe(1);
    expect(s).not.toMatch(/lemomemo(-preview)?_\$/);
    expect(s).not.toContain('continue-on-error');
    expect(t).toContain('node build/ci/desktop_scan.mjs --env "$LEMO_ENV" --latest out/latest.json');
  });
});
