// 出 exe 和正式产物的两个工作流的权限静态守护（B6-exe 安全审查 S-8）：
// desktop.yml、release-build.yml 顶层 permissions: {}，每个任务都单独写 permissions 且只有 contents: read；
// 不引用 secrets、不 secrets: inherit、不要 id-token、不写仓库、不用 environment，action 一律钉 SHA。
// 按文本逐行检查，不依赖 YAML 解析库（js-yaml 只是间接依赖）；下面另有合成样例证明拦得住。
import { readFileSync } from 'node:fs';
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
