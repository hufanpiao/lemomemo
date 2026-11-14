// 架构 2.3 A14、A20、W2 和 0.29 续第 142 条：build/check_arch.py 对样例目录要报出预期的问题
// 每个样例是一棵迷你仓库（tests/arch-fixtures/check_arch/<名字>/），用 --root 指过去
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, ROOT } from './fixture-header.ts';

interface Item {
  rule: string;
  file: string;
  line: number;
  message: string;
}
interface Report {
  errors: Item[];
  warnings: Item[];
}

function run(root: string, extra: string[] = []): { code: number; report: Report } {
  const args = ['-I', join(ROOT, 'build', 'check_arch.py'), '--root', root, '--json', '--today', '2026-10-28', ...extra];
  try {
    const out = execFileSync('python', args, { encoding: 'utf8' });
    return { code: 0, report: JSON.parse(out) as Report };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, report: JSON.parse(err.stdout) as Report };
  }
}

const sample = (name: string) => join(FIXTURES, 'check_arch', name);

/** 临时目录里现拼一棵迷你仓库，跑完删掉 */
function withRepo<T>(files: Record<string, string>, fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'lemo-check-arch-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('build/check_arch.py（tests/arch-fixtures/check_arch）', () => {
  it('A14：sb_secret_、sb_publishable_、sbp_ 后面紧跟 ≥ 20 个密钥字符 → 各一条错误', () => {
    const { code, report } = run(sample('a14-secret-prefixes'));
    expect(code).toBe(1);
    expect(report.errors.map((e) => `${e.rule} ${e.file}:${e.line}`)).toEqual([
      'A14 src/core/bad.ts:2',
      'A14 src/core/bad.ts:3',
      'A14 src/core/bad.ts:4',
    ]);
  });

  // 注意：a14-secret 这个目录名看着像“违规样例”，其实放的是“不该报”的对照样例（前缀后只有 16 个 x，B1 K4 起改成对照）；
  // 违规样例在 a14-secret-prefixes。目录不要改名：.gitleaksignore 里历史提交 df16331 的指纹按这个路径放行，改名就对不上了
  it('A14 对照：只有前缀字面量（supabase-js 产物里那种）、或前缀后不足 20 个字符 → 不报（B1 K4）', () => {
    for (const name of ['a14-secret-prefix-only', 'a14-secret']) {
      const { code, report } = run(sample(name));
      expect(report.errors, name).toEqual([]);
      expect(code, name).toBe(0);
    }
  });

  // 架构 0.51 第 2 条：VAPID 私钥是一行 JWK，值本身漏进源码或产物要认得出（kty 前后 300 个字符内有 43 个字符的 d）
  // B2 代码审查 S1：JWK 整串放在一个字符串里、引号转义成 \"（"{\"kty\":\"EC\",…\"d\":\"…\"}"）也要认得出
  it('A14：JWK 私钥 → 源码对象字面量（不带引号、冒号前后有空格、单引号）、dist 里压缩的 JSON、转义写法的字符串各报一条', () => {
    for (const [name, where] of [
      ['a14-jwk-src', 'A14 src/core/bad.ts:7'],
      ['a14-jwk-dist', 'A14 dist/web/assets/index-fake.js:2'],
      ['a14-jwk-escaped', 'A14 src/core/bad.ts:2'],
    ] as const) {
      const { code, report } = run(sample(name));
      expect(code, name).toBe(1);
      expect(report.errors.map((e) => `${e.rule} ${e.file}:${e.line}`), name).toEqual([where]);
      expect(report.errors[0]?.message, name).toContain('JWK 私钥');
    }
  });

  // 11-03 deploy-preview 失败：仓库变量 PREVIEW_SUPABASE_ANON_KEY 是 sb_publishable_…（公开值），构建后 check_arch 把它当密钥报了
  it('A14：dist/web 里的 sb_publishable_ 是公开值不报；dist 里的 sb_secret_（含和 publishable 同一文件）、源码里写死的 sb_publishable_ 照旧报', () => {
    const { code, report } = run(sample('a14-publishable-dist'));
    expect(code).toBe(1);
    expect(report.errors.map((e) => `${e.rule} ${e.file}:${e.line}`).sort()).toEqual([
      'A14 dist/web/assets/index-mixed.js:2',
      'A14 dist/web/assets/index-mixed.js:2',
      'A14 dist/web/assets/index-secret.js:2',
      'A14 src/core/bad.ts:2',
    ]);
  });

  it('A14 对照：只有公钥（含转义写法）、kid/id 里含 d、d 不是 43 个字符、d 离 kty 超过 300 个字符 → 不报', () => {
    const { code, report } = run(sample('a14-jwk-public-ok'));
    expect(report.errors).toEqual([]);
    expect(code).toBe(0);
  });

  it('A14：import.meta.env 读了非 VITE_PUBLIC_* → 错误', () => {
    const { code, report } = run(sample('a14-env'));
    expect(code).toBe(1);
    expect(report.errors.some((e) => e.rule === 'A14' && e.message.includes('SUPABASE_SERVICE_KEY'))).toBe(true);
  });

  it('A20：JSX 文本里的中文 → 错误；字符串里的谚文 → 错误', () => {
    expect(run(sample('a20-jsx-text')).report.errors.map((e) => e.rule)).toEqual(['A20']);
    expect(run(sample('a20-string')).report.errors.map((e) => e.rule)).toEqual(['A20']);
  });

  it('A20：文件头豁免只在 shared/logic/parse/ 有效', () => {
    expect(run(sample('a20-header-elsewhere')).report.errors.map((e) => e.rule)).toEqual(['A20']);
  });

  it('A24：CSS 里 stylelint-disable 不写规则名、关 lemo/*、关 A24 的规则 → 各一条错误（UI-4 M4 第三轮）', () => {
    const { code, report } = run(sample('a24-stylelint-disable'));
    expect(code).toBe(1);
    const a24 = report.errors.filter((e) => e.rule === 'A24');
    expect(a24.map((e) => e.line)).toEqual([2, 7, 13]);
    expect(a24[0]?.message).toContain('不写规则名');
    expect(a24[1]?.message).toContain('lemo/reduced-motion-override');
    expect(a24[2]?.message).toContain('declaration-property-value-disallowed-list');
  });

  it('A24 对照：关别的规则（写了说明）不报', () => {
    const { code, report } = run(sample('a24-stylelint-disable-ok'));
    expect(report.errors).toEqual([]);
    expect(code).toBe(0);
  });

  it('对照：i18n 目录、注释、带豁免头的解析词表都不报；节假日齐全时没有警告', () => {
    const { code, report } = run(sample('a20-ok'));
    expect(report).toEqual({ errors: [], warnings: [] });
    expect(code).toBe(0);
  });

  it('W2：缺明年的节假日文件 → 两条警告（cn、kr），退出码仍是 0', () => {
    const { code, report } = run(sample('w2-missing'));
    expect(code).toBe(0);
    expect(report.warnings.map((w) => `${w.rule} ${w.file}`)).toEqual([
      'W2 src/public/holidays/cn',
      'W2 src/public/holidays/kr',
    ]);
  });

  it('W2：明年的文件还是 pending（未公布）→ 照样警告，只报 cn', () => {
    const { code, report } = run(sample('w2-pending'));
    expect(code).toBe(0);
    expect(report.warnings.map((w) => `${w.rule} ${w.file}`)).toEqual(['W2 src/public/holidays/cn']);
    expect(report.warnings[0]?.message).toContain('pending');
  });

  it('第 142 条：private 触发器函数里用 current_user → 错误；普通函数和用 current_setting 的不报', () => {
    const { code, report } = run(sample('p142-current-user'));
    expect(code).toBe(1);
    const p142 = report.errors.filter((e) => e.rule === 'P142');
    expect(p142).toHaveLength(1);
    expect(p142[0]?.message).toContain('private.guard_profile_disabled');
    expect(p142[0]?.line).toBe(5);
  });

  it('A19：SW 只走网络的前缀表漏了 /files → 错误（15.3 第 1 条，0.32）', () => {
    const { code, report } = run(sample('a19-files-not-bypassed'));
    expect(code).toBe(1);
    expect(report.errors.map((e) => `${e.rule} ${e.file}`)).toEqual(['A19 src/sw/routes.ts']);
    expect(report.errors[0]?.message).toContain("'/files'");
  });

  it('A19：sw.ts 另给 /files 挂缓存路由 → 错误；注释和 /filesystem 不算', () => {
    const { code, report } = run(sample('a19-sw-files-route'));
    expect(code).toBe(1);
    expect(report.errors.map((e) => `${e.rule} ${e.file}:${e.line}`)).toEqual(['A19 src/sw/sw.ts:4']);
  });

  // 11-14 整块评审：A20、A19 的去注释改用 check_backend_ast.mjs 的 AST 输出（原来是手写词法器，不认正则字面量）
  it('A20（AST 去注释）：正则里的引号后面跟注释、同一行末尾的注释、JSX 里的 {/* */} 都不报；字符串里的照报，行号对', () => {
    const body = [
      "const re = /'/; // 正则里有引号，后面的注释不算",
      'const n = 1; /* 行尾的块注释 */',
      "export const s = '中文'; // 2 后面还有注释",
      'export const A = () => <p>{/* 注释 */}x</p>;',
      '',
    ].join('\n');
    const { report } = withRepo({ 'src/core/a.tsx': body }, (root) => run(root, ['--only', 'A20']));
    expect(report.errors.map((e) => `${e.rule} ${e.file}:${e.line}`)).toEqual(['A20 src/core/a.tsx:3']);
  });

  it('A19（AST 去注释）：sw 里行尾注释提到 /files 不报，字符串照报', () => {
    const files = {
      'src/sw/routes.ts': "export const NETWORK_ONLY_PREFIXES = ['/sb', '/files']; // '/x'\n",
      'src/sw/sw.ts': "const a = 1; // '/files' 只在注释里\nconst b = '/sb/x';\n",
    };
    const { report } = withRepo(files, (root) => run(root, ['--only', 'A19']));
    expect(report.errors.map((e) => `${e.rule} ${e.file}:${e.line}`)).toEqual(['A19 src/sw/sw.ts:2']);
  });

  it('--only：只跑列出的规则（构建后那次 --only A14）；规则名写错、写空退出 2', () => {
    const files = { 'src/core/bad.ts': "export const s = '中文';\nexport const v = import.meta.env.SECRET;\n" };
    withRepo(files, (root) => {
      expect(run(root).report.errors.map((e) => e.rule).sort()).toEqual(['A14', 'A20']);
      expect(run(root, ['--only', 'A14']).report.errors.map((e) => e.rule)).toEqual(['A14']);
      expect(run(root, ['--only', 'A20,A14']).report.errors.map((e) => e.rule).sort()).toEqual(['A14', 'A20']);
      for (const bad of ['A99', '']) {
        let status = 0;
        try {
          execFileSync('python', ['-I', join(ROOT, 'build', 'check_arch.py'), '--root', root, '--only', bad], { encoding: 'utf8', stdio: 'pipe' });
        } catch (e) {
          status = (e as { status: number }).status;
        }
        expect(status, bad).toBe(2);
      }
    });
  });

  // R2、LUNAR、MOTION-IMPL 11-14 起由 ESLint lemo/import-bounds 管，样例和用例在 tests/arch/import-bounds.test.ts（CI-11）

  it('真仓库：0 个错误', { timeout: 60_000 }, () => {
    const { code, report } = run(ROOT);
    expect(report.errors).toEqual([]);
    expect(code).toBe(0);
  });
});
