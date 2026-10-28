// 架构 2.3 A14、A20、W2 和 0.29 续第 142 条：build/check_arch.py 对样例目录要报出预期的问题
// 每个样例是一棵迷你仓库（tests/arch-fixtures/check_arch/<名字>/），用 --root 指过去
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
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

function run(root: string): { code: number; report: Report } {
  const args = ['-I', join(ROOT, 'build', 'check_arch.py'), '--root', root, '--json', '--today', '2026-10-28'];
  try {
    const out = execFileSync('python', args, { encoding: 'utf8' });
    return { code: 0, report: JSON.parse(out) as Report };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, report: JSON.parse(err.stdout) as Report };
  }
}

const sample = (name: string) => join(FIXTURES, 'check_arch', name);

describe('build/check_arch.py（tests/arch-fixtures/check_arch）', () => {
  it('A14：源码里有密钥特征 → 错误', () => {
    const { code, report } = run(sample('a14-secret'));
    expect(code).toBe(1);
    expect(report.errors.map((e) => e.rule)).toContain('A14');
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

  it('第 142 条：private 触发器函数里用 current_user → 错误；普通函数和用 current_setting 的不报', () => {
    const { code, report } = run(sample('p142-current-user'));
    expect(code).toBe(1);
    const p142 = report.errors.filter((e) => e.rule === 'P142');
    expect(p142).toHaveLength(1);
    expect(p142[0]?.message).toContain('private.guard_profile_disabled');
    expect(p142[0]?.line).toBe(5);
  });

  it('真仓库：0 个错误', { timeout: 60_000 }, () => {
    const { code, report } = run(ROOT);
    expect(report.errors).toEqual([]);
    expect(code).toBe(0);
  });
});
