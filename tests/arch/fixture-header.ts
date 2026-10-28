// 读 tests/arch-fixtures/ 样例文件头：
//   // arch-fixture: path=<虚拟路径> expect=<规则>[,<规则>] [severity=warn] [rule=<架构规则号>] [message=<片段>] [count=<n>]
// path 是“假装这段代码放在仓库哪里”，ESLint、Stylelint 按这个路径套目录规则；expect=none 表示应通过（对照组）
// rule：这个样例证明的是架构 2.3 的哪一条（A13、T1…），tests/arch/coverage.test.ts 按规则表核“每条都有违规样例”（QA D-06）
// message：报错文字里必须有这一段——同一个 ESLint 规则 id 下挂了很多条（no-restricted-syntax 管 A2、A12、A13…），
//   只比 ruleId 会被“别的一条”拦住也算过（代码审查低 11）
// count：同一个样例里写了几种违规写法，每种都要报（至少报 n 处）
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
  /** 架构规则号（A13、T1…）；对照组没有 */
  rule: string | undefined;
  /** 报错文字里必须出现的片段 */
  message: string | undefined;
  /** 至少报几处 */
  count: number;
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
  const count = Number(kv.get('count') ?? '1');
  if (!Number.isInteger(count) || count < 1) throw new Error(`${file}：count 要是正整数`);
  if (expect.length > 0 && !kv.get('rule')) throw new Error(`${file}：违规样例要写 rule=<架构规则号>（QA D-06）`);
  return {
    path: kv.get('path') ?? '',
    expect,
    severity: kv.get('severity') === 'warn' ? 1 : 2,
    rule: kv.get('rule'),
    message: kv.get('message'),
    count,
  };
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
