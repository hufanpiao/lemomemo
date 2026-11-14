// 全部工作流的权限底线（第三方审查 CI-16：原来只有 workflow-permissions.test.ts 守 desktop、release-build 两个，带密钥的 deploy-preview、ai-eval 没人管）：
// .github/workflows 下每个 yml（以后新加的自动算进来）：
// • 顶层正好一行 permissions: {}（任务要什么自己写）；任务里的权限只许 read，不许 write、read-all、write-all
// • 不用 pull_request_target、workflow_run（带着密钥跑别人的代码）、不 secrets: inherit
// • action 一律钉 40 位 SHA（本仓库内的 ./ 引用除外）
// • ${{ secrets.X }} 只许出现在下面名单里的文件、只许这些名字
// 按文本逐行查，不依赖 YAML 解析库；下面另有合成样例证明拦得住。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(import.meta.dirname, '..', '..', '.github', 'workflows');

/** 哪个工作流可以引用哪些机密（挪名字或加机密要同时改这里） */
const SECRETS_ALLOWED: Record<string, readonly string[]> = {
  'deploy-preview.yml': ['PREVIEW_SUPABASE_ACCESS_TOKEN', 'PREVIEW_SUPABASE_DB_PASSWORD', 'PREVIEW_CLOUDFLARE_API_TOKEN'],
  'ai-eval.yml': ['GEMINI_EVAL_KEY'],
};

/** 去掉注释和空行，保留行号 */
const codeLines = (text: string) =>
  text
    .split('\n')
    .map((raw, i) => ({ no: i + 1, line: raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '').trimEnd() }))
    .filter((x) => x.line.trim() !== '');

const PERM_KEY = /^\s+(actions|attestations|checks|contents|deployments|discussions|id-token|issues|models|packages|pages|pull-requests|repository-projects|security-events|statuses):\s*(\S+)/;

function checkBaseline(name: string, text: string): string[] {
  const problems: string[] = [];
  const lines = codeLines(text);
  const top = lines.filter((x) => x.line.startsWith('permissions:'));
  if (top.length !== 1 || top[0]?.line.replace(/\s/g, '') !== 'permissions:{}') problems.push('顶层必须正好一行 permissions: {}');
  const allowed = SECRETS_ALLOWED[name] ?? [];
  for (const { no, line } of lines) {
    if (/\b(pull_request_target|workflow_run)\b/.test(line)) problems.push(`第 ${no} 行用了危险的触发方式：${line.trim()}`);
    if (/secrets:\s*inherit/.test(line)) problems.push(`第 ${no} 行 secrets: inherit`);
    if (/:\s*(write-all|read-all)\b/.test(line)) problems.push(`第 ${no} 行用了 read-all / write-all`);
    const perm = PERM_KEY.exec(line);
    if (perm && perm[2] !== 'read') problems.push(`第 ${no} 行权限 ${perm[1]}: ${perm[2]}，只许 read`);
    const ref = /^\s*-?\s*uses:\s*(\S+)/.exec(line)?.[1];
    if (ref && !ref.startsWith('./') && !/@[0-9a-f]{40}$/.test(ref)) problems.push(`第 ${no} 行 action 没钉 SHA：${ref}`);
    for (const m of line.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)/g)) {
      if (!allowed.includes(m[1] ?? '')) problems.push(`第 ${no} 行引用了不在名单里的机密 ${m[1]}`);
    }
  }
  return problems;
}

describe('全部工作流的权限底线（CI-16）', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  it('至少有 6 个工作流（防止目录读错、什么都没查就过）', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  for (const f of files) {
    it(`${f} 守住底线`, () => {
      expect(checkBaseline(f, readFileSync(join(DIR, f), 'utf8'))).toEqual([]);
    });
  }

  it('名单里的工作流和机密都真实存在（名单不留过时的条目）', () => {
    for (const [f, names] of Object.entries(SECRETS_ALLOWED)) {
      const text = readFileSync(join(DIR, f), 'utf8');
      for (const n of names) expect(text, `${f} ${n}`).toContain(`secrets.${n}`);
    }
  });
});

describe('合成样例：底线拦得住', () => {
  const ok = 'name: x\non: push\npermissions: {}\njobs:\n  a:\n    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@' + 'a'.repeat(40) + '\n';
  it('合规的样例不报', () => {
    expect(checkBaseline('x.yml', ok)).toEqual([]);
  });
  it.each([
    ['缺顶层 permissions', ok.replace('permissions: {}\n', '')],
    ['写权限', ok.replace('contents: read', 'contents: write')],
    ['id-token 写', ok.replace('contents: read', 'id-token: write')],
    ['write-all', ok.replace('permissions: {}', 'permissions: write-all')],
    ['workflow_run 触发', ok.replace('on: push', 'on:\n  workflow_run:\n    workflows: [unit]')],
    ['pull_request_target 触发', ok.replace('on: push', 'on: pull_request_target')],
    ['没钉 SHA', ok.replace('@' + 'a'.repeat(40), '@v4')],
    ['secrets: inherit', ok + '  b:\n    uses: ./.github/workflows/y.yml\n    secrets: inherit\n'],
    ['名单外的机密', ok + '        env:\n          K: ${{ secrets.PROD_TOKEN }}\n'],
  ])('%s 要报', (_what, text) => {
    expect(checkBaseline('x.yml', text).length).toBeGreaterThan(0);
  });
  it('名单内的机密只在对应文件放行', () => {
    const t = ok + '        env:\n          K: ${{ secrets.GEMINI_EVAL_KEY }}\n';
    expect(checkBaseline('ai-eval.yml', t)).toEqual([]);
    expect(checkBaseline('ci.yml', t).length).toBeGreaterThan(0);
  });
  it('注释里写的不算', () => {
    expect(checkBaseline('x.yml', ok + '# uses: foo/bar@v1 secrets.X workflow_run\n')).toEqual([]);
  });
});
