// 出 exe 和正式产物的两个工作流的权限静态守护（B6-exe 安全审查 S-8）：
// desktop.yml、release-build.yml 顶层 permissions: {}，每个任务都单独写 permissions 且只有 contents: read；
// 不引用 secrets、不 secrets: inherit、不要 id-token、不写仓库、不用 environment，action 一律钉 SHA。
// 按文本逐行检查，不依赖 YAML 解析库（js-yaml 只是间接依赖）；下面另有合成样例证明拦得住。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runOf, workflowSteps as steps, type Step } from './workflow-steps.ts';

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
// 每个上传步骤的**上一步（同一任务内）**必须就是对同样的路径调 build/ci/no-hidden-files.sh（脚本的正反例在 ci-guard-scripts.test.ts）、
// 不许 continue-on-error，条件（if）和上传步骤相同；也不许打开 include-hidden-files（工作流隐藏文件审查 M1、建议 1）。
// path 可以是一行，也可以是 path: | 的多行（每一行都要在检查的参数里，顺序不管）；检查带 --allow-missing 的，上传必须是 if-no-files-found: ignore
// （11-14 整块评审：原来只核 desktop、release-build、ai-eval 三份，ci.yml 两处、deploy-preview.yml 一处上传前没查）
const WORKFLOWS = readdirSync(join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`);
/** 上传步骤 with: 里 path 的各项（去掉末尾的 /） */
function uploadPaths(st: Step): string[] {
  const at = st.lines.findIndex((l) => /^ {10}path:/.test(l));
  if (at < 0) return [];
  const head = (st.lines[at] ?? '').replace(/^ {10}path:\s*/, '');
  const items = /^[|>][-+]?$/.test(head) ? st.lines.slice(at + 1).filter((l) => /^ {12}\S/.test(l)).map((l) => l.trim()) : [head];
  return items.map((p) => p.replace(/\/$/, ''));
}
function checkUploads(text: string): string[] {
  const problems: string[] = [];
  const all = steps(text);
  all.forEach((st, i) => {
    if (!/uses: actions\/upload-artifact@/.test(st.text)) return;
    if (/include-hidden-files:\s*true/.test(st.text)) problems.push(`${st.name}：不要打开 include-hidden-files`);
    const paths = uploadPaths(st);
    if (!paths.length) return void problems.push(`${st.name}：没有 path`);
    const g = all[i - 1];
    const m = g && g.job === st.job ? /^bash build\/ci\/no-hidden-files\.sh((?: \S+)+)$/.exec(runOf(g)) : null;
    const args = (m?.[1] ?? '').trim().split(' ').filter(Boolean);
    const allowMissing = args[0] === '--allow-missing';
    const checked = (allowMissing ? args.slice(1) : args).map((p) => p.replace(/\/$/, ''));
    if (!g || !m || [...checked].sort().join(' ') !== [...paths].sort().join(' ')) {
      return void problems.push(`${st.name}：上一步（同一任务内）不是对 ${paths.join(' ')} 调 build/ci/no-hidden-files.sh`);
    }
    if (allowMissing && !/^ {10}if-no-files-found: ignore$/m.test(st.text)) problems.push(`${st.name}：检查带 --allow-missing，上传就要 if-no-files-found: ignore`);
    if (/continue-on-error/.test(g.text)) problems.push(`${st.name}：查点开头文件那一步不许 continue-on-error`);
    if (g.cond !== st.cond) problems.push(`${st.name}：查点开头文件那一步的条件（${g.cond || '无'}）和上传的（${st.cond || '无'}）不一样`);
  });
  return problems;
}

describe('上传产物前查点开头的文件（upload-artifact 默认不传它们）', () => {
  it('所有工作流都核（原来漏的 ci.yml、deploy-preview.yml 都在里面）', () => {
    expect(WORKFLOWS).toEqual(expect.arrayContaining(['.github/workflows/ci.yml', '.github/workflows/deploy-preview.yml', '.github/workflows/ai-eval.yml']));
  });
  for (const f of WORKFLOWS.filter((w) => readFileSync(join(ROOT, w), 'utf8').includes('upload-artifact@'))) {
    it(`${f}：每个上传步骤的上一步都是对应的检查`, () => {
      const t = readFileSync(join(ROOT, f), 'utf8');
      expect(steps(t).filter((s) => s.text.includes('upload-artifact@')).length).toBeGreaterThan(0);
      expect(checkUploads(t)).toEqual([]);
    });
  }

  const up = (cond = '') => `      - name: 上传\n${cond ? `        if: ${cond}\n` : ''}        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2\n        with:\n          name: x\n          path: out/\n`;
  const guard = (cond = '', extra = '', dir = 'out') => `      - name: 查\n${cond ? `        if: ${cond}\n` : ''}${extra}        run: bash build/ci/no-hidden-files.sh ${dir}\n`;
  const other = '      - name: 别的\n        run: echo hi\n';
  const job = (name: string, body: string) => `  ${name}:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;
  const wf = (...jobs: string[]) => `name: x\njobs:\n${jobs.join('')}`;
  it('合成样例：上一步是检查、条件相同的通过', () => {
    expect(checkUploads(wf(job('a', guard() + up())))).toEqual([]);
    expect(checkUploads(wf(job('a', guard("a == 'b'") + up("a == 'b'"))))).toEqual([]);
  });
  it('合成样例：缺检查、条件不同、打开 include-hidden-files 的拦下', () => {
    expect(checkUploads(wf(job('a', up()))).join()).toMatch(/不是对 out 调/);
    expect(checkUploads(wf(job('a', guard("a == 'b'") + up()))).join()).toMatch(/条件/);
    expect(checkUploads(wf(job('a', `${guard()}${up()}          include-hidden-files: true\n`))).join()).toMatch(/include-hidden-files/);
  });
  const multi = (guardArgs: string, ignore = false) =>
    wf(
      job(
        'a',
        guard('', '', guardArgs) +
          '      - name: 上传\n        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2\n' +
          `        with:\n          name: x\n          path: |\n            a/\n            b/c\n${ignore ? '          if-no-files-found: ignore\n' : ''}`,
      ),
    );
  it('合成样例：多行 path: | 每一项都查到（顺序不管）的通过；漏一项、--allow-missing 却没写 if-no-files-found: ignore 的拦下', () => {
    expect(checkUploads(multi('b/c a'))).toEqual([]);
    expect(checkUploads(multi('--allow-missing a/ b/c', true))).toEqual([]);
    expect(checkUploads(multi('a')).join()).toMatch(/不是对 a b\/c 调/);
    expect(checkUploads(multi('--allow-missing a b/c')).join()).toMatch(/if-no-files-found: ignore/);
  });
  it('合成样例：检查和上传中间夹一步、检查在别的任务里、查的是别的目录、带 continue-on-error、自己写一份 find 不调脚本的拦下（M1、CI-8）', () => {
    expect(checkUploads(wf(job('a', guard() + other + up()))).join()).toMatch(/上一步（同一任务内）不是/);
    expect(checkUploads(wf(job('a', guard()), job('b', up()))).join()).toMatch(/上一步（同一任务内）不是/);
    expect(checkUploads(wf(job('a', guard('', '', 'out/sub') + up()))).join()).toMatch(/不是对 out 调/);
    expect(checkUploads(wf(job('a', guard('', '        continue-on-error: true\n') + up()))).join()).toMatch(/continue-on-error/);
    const inline = `      - name: 查\n        run: |\n          hidden="$(find -L out -name '.*' -print)"\n          if [ -n "$hidden" ]; then exit 1; fi\n`;
    expect(checkUploads(wf(job('a', inline + up()))).join()).toMatch(/no-hidden-files\.sh/);
  });
});

const BASH = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => existsSync(p)) : 'bash';

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

// 评测工作流 ai-eval.yml（B3 任务单 S19、Q5；AI 句库 5.2）：只能手动触发；机密只有 GEMINI_EVAL_KEY、只在“查密钥”“跑评测和补跑”“上传前扫密钥原值”三步的 env 里；
// 除这两行外照上面 desktop / release-build 的规矩（顶层 {}、只 contents: read、钉 SHA）；上传前查点开头的文件；
// 手动输入只经 env 进脚本（不在 run 里直接展开）；没有这把 secret 时第一步就失败、不空跑，也不把值打进日志
describe('ai-eval.yml：只手动触发、只用一把评测密钥', () => {
  const t = readFileSync(join(ROOT, '.github/workflows/ai-eval.yml'), 'utf8');
  const all = steps(t);
  /** 步骤 env 里那一行（缩进 10 格） */
  const SECRET_LINE = '          GEMINI_EVAL_KEY: ${{ secrets.GEMINI_EVAL_KEY }}\n';
  it('触发只有 workflow_dispatch', () => {
    const on = t.slice(t.indexOf('\non:\n'), t.indexOf('\npermissions:'));
    expect(on.split('\n').filter((l) => /^ {2}[^\s#]/.test(l)).map((l) => l.trim())).toEqual(['workflow_dispatch:']);
  });
  it('机密只有 GEMINI_EVAL_KEY，正好三处，在“查评测密钥”“跑评测和补跑”“上传前扫密钥原值”三步的 env 里', () => {
    expect(codeLines(t).map((x) => x.line).join('\n').match(/secrets\.\w+/g)).toEqual(['secrets.GEMINI_EVAL_KEY', 'secrets.GEMINI_EVAL_KEY', 'secrets.GEMINI_EVAL_KEY']);
    const withKey = all.filter((s) => `${s.text}\n`.includes(`        env:\n${SECRET_LINE}`));
    expect(withKey.map((s) => s.name.split('（')[0])).toEqual(['查评测密钥', '跑评测和补跑', '上传前扫密钥原值']);
  });
  it('去掉那三行以后，权限、钉 SHA 等规矩和 desktop / release-build 一样', () => {
    expect(t.split(SECRET_LINE).length).toBe(4);
    expect(checkWorkflow(t.split(SECRET_LINE).join(''))).toEqual([]);
  });
  it('上传前一步查点开头的文件；扫密钥原值那一步过了才查、才上传', () => {
    expect(all.filter((s) => s.text.includes('upload-artifact@')).length).toBe(1);
    expect(checkUploads(t)).toEqual([]);
    const i = all.findIndex((s) => s.text.includes('upload-artifact@'));
    expect(all[i]?.cond).toBe("always() && steps.keyscan.outcome == 'success'");
    expect(all[i - 2]?.name.startsWith('上传前扫密钥原值')).toBe(true);
    expect(all[i - 2]?.text).toMatch(/^ {8}id: keyscan$/m);
  });
  it('手动输入只经 env 进脚本', () => {
    const uses = t.split('\n').filter((l) => l.includes('${{ inputs.'));
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((l) => !/^ {10}[A-Z_]+: \$\{\{ inputs\.\w+ \}\}$/.test(l))).toEqual([]);
  });
  // 把某一步的 run 原样取出来真跑
  const scriptOf = (prefix: string) => {
    const lines = (all.find((s) => s.name.startsWith(prefix))?.text ?? '').split('\n');
    return lines.slice(lines.findIndex((l) => l.trim() === 'run: |') + 1).filter((l) => l.startsWith('          ') || l.trim() === '').map((l) => l.slice(10)).join('\n');
  };
  const script = scriptOf('查评测密钥');
  it.skipIf(!BASH)('没有 secret（或为空）：报错退出；有：通过，日志里没有值', () => {
    const d = mkdtempSync(join(tmpdir(), 'lemo-aieval-'));
    try {
      writeFileSync(join(d, 'check.sh'), `${script}\n`);
      const go = (v: string | undefined) => {
        const env: Record<string, string> = { PATH: process.env['PATH'] ?? '' };
        if (v !== undefined) env['GEMINI_EVAL_KEY'] = v;
        const r = spawnSync(BASH ?? 'bash', ['--noprofile', '--norc', '-eo', 'pipefail', 'check.sh'], { cwd: d, encoding: 'utf8', env });
        return { code: r.status, out: r.stdout + r.stderr };
      };
      for (const v of [undefined, '']) {
        const r = go(v);
        expect(r.code).toBe(1);
        expect(r.out).toContain('::error::仓库没有 secret GEMINI_EVAL_KEY');
      }
      const ok = go('AIzaFAKE-not-a-key');
      expect(ok.code).toBe(0);
      expect(ok.out).not.toContain('AIzaFAKE');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  // 扫密钥那一步真跑：在临时目录里搭 tests/ai/reports，按 grep 的三种退出码各跑一次（安全复查 M1）
  const KEY = 'AIzaFAKE-scan-0123456789';
  const scan = (setup: (reports: string, d: string) => void) => {
    const d = mkdtempSync(join(tmpdir(), 'lemo-aieval-scan-'));
    try {
      writeFileSync(join(d, 'scan.sh'), `${scriptOf('上传前扫密钥原值')}\n`);
      setup(join(d, 'tests', 'ai', 'reports'), d);
      const r = spawnSync(BASH ?? 'bash', ['--noprofile', '--norc', '-eo', 'pipefail', 'scan.sh'], { cwd: d, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', GEMINI_EVAL_KEY: KEY } });
      return { code: r.status, out: r.stdout + r.stderr };
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  const reportsWith = (files: Record<string, string>) => (reports: string) => {
    mkdirSync(reports, { recursive: true });
    for (const [n, body] of Object.entries(files)) writeFileSync(join(reports, n), body);
  };
  it('扫密钥不把密钥放进 grep 的命令行参数（-f 从管道读），用 -R 跟进链接', () => {
    const sc = scriptOf('上传前扫密钥原值');
    expect(sc).toContain(`grep -RlF -f <(printf '%s' "$GEMINI_EVAL_KEY") tests/ai/reports`);
    expect(sc).not.toMatch(/\|\| true/);
    expect(sc).not.toMatch(/grep[^\n]*-e "\$GEMINI_EVAL_KEY"/);
  });
  it.skipIf(!BASH)('扫密钥 grep 退出 0（有文件含原值）：失败，只报文件名、不打印值', () => {
    const r = scan(reportsWith({ 'set1-a.json': '{"raw":"没有密钥"}', 'only-b.json': `{"raw":"x-goog-api-key: ${KEY}"}` }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('tests/ai/reports/only-b.json');
    expect(r.out).not.toContain('tests/ai/reports/set1-a.json');
    expect(r.out).toContain('::error::tests/ai/reports 里有 1 个文件含评测密钥原值');
    expect(r.out).not.toContain(KEY);
  });
  it.skipIf(!BASH)('扫密钥 grep 退出 1（没有文件含原值）：通过', () => {
    const r = scan(reportsWith({ 'set1-a.json': '{"raw":"没有密钥"}', 'only-b.json': '{"raw":"AIzaFAKE-scan-01234"}' }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('没有扫到密钥原值');
  });
  it.skipIf(!BASH)('扫密钥 grep 退出 2（reports 目录不存在，读出错）：失败、不放行', () => {
    const r = scan(() => {});
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::扫密钥时 grep 出错（退出码 2），没扫全，不上传');
    expect(r.out).not.toContain('没有扫到密钥原值');
  });
  // Windows 上建符号链接要特权（EPERM），这两条和上面 find -L 那条一样只在 Linux / macOS 上跑（CI 是 ubuntu）
  it.skipIf(!BASH || process.platform === 'win32')('扫密钥 grep 退出 2（链接指向不存在的目标）：失败、不放行', () => {
    const r = scan((reports) => {
      reportsWith({ 'set1-a.json': '{"raw":"没有密钥"}' })(reports);
      symlinkSync(join(reports, 'nope.json'), join(reports, 'dangling.json'));
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::扫密钥时 grep 出错（退出码 2），没扫全，不上传');
    expect(r.out).not.toContain('没有扫到密钥原值');
  });
  it.skipIf(!BASH || process.platform === 'win32')('扫密钥跟进链接：链接指向 reports 外面的文件里有原值，要被扫到', () => {
    const r = scan((reports, d) => {
      reportsWith({ 'set1-a.json': '{"raw":"没有密钥"}' })(reports);
      writeFileSync(join(d, 'outside.json'), `{"raw":"${KEY}"}`);
      symlinkSync(join(d, 'outside.json'), join(reports, 'linked.json'));
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('tests/ai/reports/linked.json');
    expect(r.out).toContain('::error::tests/ai/reports 里有 1 个文件含评测密钥原值');
    expect(r.out).not.toContain(KEY);
  });
});

// 11-14 整块评审：lemo/import-bounds 的 LUNAR 间接那条要读别的文件，ESLint 的 --cache 只看本文件改没改，shared/ 改了会沿用旧结果漏报。
// package.json 的 lint 和各工作流里调 eslint、npm run lint 的命令都不许带 --cache（规则文件头、eslint.config.js 写明）
describe('lint 不许加 --cache', () => {
  const ALL = readdirSync(join(ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));
  it('package.json 的 lint 调 eslint、不带 --cache；别的 script 里调 eslint 的也不带', () => {
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['lint']).toMatch(/\beslint\b/);
    expect(Object.entries(scripts).filter(([, v]) => /\beslint\b/.test(v) && /--cache\b/.test(v)).map(([k]) => k)).toEqual([]);
  });
  it('工作流里跑 eslint、npm run lint 的步骤都不带 --cache（至少 unit.yml 那一处在）', () => {
    const cmds = ALL.flatMap((f) => steps(readFileSync(join(ROOT, '.github', 'workflows', f), 'utf8')).map((s) => ({ f, run: runOf(s) }))).flatMap(({ f, run }) =>
      run
        .split('\n')
        .filter((l) => /\beslint\b|npm run lint\b/.test(l) && !/^\s*#/.test(l))
        .map((l) => `${f}: ${l.trim()}`),
    );
    expect(cmds.some((c) => c.startsWith('unit.yml: npm run lint'))).toBe(true);
    expect(cmds.filter((c) => /--cache\b/.test(c))).toEqual([]);
  });
});
