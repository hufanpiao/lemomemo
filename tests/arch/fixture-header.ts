// 读 tests/arch-fixtures/ 样例文件头：// arch-fixture: path=<虚拟路径> expect=<规则>[,<规则>] [severity=warn]
// path 是“假装这段代码放在仓库哪里”，ESLint、Stylelint 按这个路径套目录规则；expect=none 表示应通过（对照组）
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const FIXTURES = join(ROOT, 'tests', 'arch-fixtures');

export interface Fixture {
  file: string;
  code: string;
  path: string;
  expect: string[];
  severity: 1 | 2;
}

const HEADER = /arch-fixture:\s*(.*?)\s*(?:\*\/)?$/m;

export function parseHeader(file: string, code: string): Omit<Fixture, 'file' | 'code'> {
  const first = code.split('\n', 1)[0] ?? '';
  const m = HEADER.exec(first);
  if (!m?.[1]) throw new Error(`${file}：第一行没有 arch-fixture 文件头`);
  const kv = new Map(
    m[1].split(/\s+/).map((pair) => {
      const i = pair.indexOf('=');
      return [pair.slice(0, i), pair.slice(i + 1)] as const;
    }),
  );
  const expect = (kv.get('expect') ?? '').split(',').filter((x) => x !== '' && x !== 'none');
  return { path: kv.get('path') ?? '', expect, severity: kv.get('severity') === 'warn' ? 1 : 2 };
}

export function loadFixtures(sub: string): Fixture[] {
  const dir = join(FIXTURES, sub);
  return readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .sort()
    .map((f) => {
      const code = readFileSync(join(dir, f), 'utf8');
      return { file: f, code, ...parseHeader(f, code) };
    });
}
