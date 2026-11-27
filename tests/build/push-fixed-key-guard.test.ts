// C-5 的“代码审查核对”落地（B2 代码审查 BE-1 S5）：supabase/functions/_shared/push/ece.ts 的 encryptWithFixedKeysForTest 只给测试用
// （固定临时私钥和 salt，用来对 RFC 8291 附录 A）。tests/ 以外，除了 ece.ts 里的定义，任何源码都不准出现这个名字——
// 包括 import、重新导出、字符串里拼名字动态取。注释里提到也算（宁可多报），要写说明就写在 tests/ 里
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../arch/fixture-header.ts';

const NAME = 'encryptWithFixedKeysForTest';
const DEFINED_IN = 'supabase/functions/_shared/push/ece.ts';
const SKIP_DIRS = new Set(['node_modules', '.git', 'docs', 'tests', 'dist', '.temp', '.e2e-sb', '.wrangler', '.claude', 'playwright-report', 'test-results', 'target']);
const EXT = /\.(?:[cm]?[jt]sx?|json|sql|py|ps1|sh|toml)$/;

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else if (EXT.test(name)) {
      out.push(relative(ROOT, full).split('\\').join('/'));
    }
  }
  return out;
}

describe('encryptWithFixedKeysForTest 只在测试里用（C-5，代码审查 S5）', () => {
  const files = walk(ROOT, []);

  it('扫到了后端源码（防止目录写错扫了个空）', () => {
    expect(files).toContain(DEFINED_IN);
    expect(files).toContain('supabase/functions/push-dispatch/core.ts');
  });

  it('tests/ 以外只有 ece.ts 出现这个名字，而且 ece.ts 的代码里只出现在定义那一行', () => {
    const hits = files.filter((f) => readFileSync(join(ROOT, f), 'utf8').includes(NAME));
    expect(hits).toEqual([DEFINED_IN]);
    // ece.ts 自己的说明注释（//、/*、* 开头的行）可以提到；代码行只能是定义那一行
    const code = readFileSync(join(ROOT, DEFINED_IN), 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|\/\*|\*)/.test(l));
    const lines = code.filter((l) => l.includes(NAME));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(`export async function ${NAME}(`)).toBe(true);
  });
});
