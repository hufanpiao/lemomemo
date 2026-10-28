// TC-B0-52：免查名单里写了不存在的函数，检查脚本报错
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkExemptFunctions, checkRules } from '../../build/check_version_gate.mjs';
import { EXEMPT_RULES, needsVersionCheck } from '../../functions/sb/version-gate.ts';

type Check = (exempt: readonly { name: string; methods: readonly string[] }[], dir: string) => string[];
const check = checkExemptFunctions as Check;

function fakeFunctionsDir(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lemo-fn-'));
  for (const n of names) {
    mkdirSync(join(dir, n));
    writeFileSync(join(dir, n, 'index.ts'), '');
  }
  return dir;
}

describe('check_version_gate', () => {
  it('名单里的函数都存在 → 通过', () => {
    const dir = fakeFunctionsDir(['account', 'note-search']);
    expect(check([{ name: 'account', methods: ['POST'] }, { name: 'note-search', methods: ['*'] }], dir)).toEqual([]);
  });

  it('名单里有、目录里没有 → 报出函数名', () => {
    const dir = fakeFunctionsDir(['account']);
    const errs = check([{ name: 'no-such-fn', methods: ['POST'] }], dir);
    expect(errs.join('\n')).toContain('no-such-fn');
  });

  it('重复、没写方法、名字不合规都报', () => {
    const dir = fakeFunctionsDir(['a']);
    expect(check([{ name: 'a', methods: ['POST'] }, { name: 'a', methods: [] }], dir).length).toBe(2);
    expect(check([{ name: '../x', methods: ['POST'] }], dir).length).toBeGreaterThan(0);
  });
});

// 0.32（R-213，14.2 第 10、11 点）：存储不再免查；/files 只有 PUT 查
describe('check_version_gate：0.32 的规则', () => {
  type Rules = (rules: readonly { method: string; path: string }[], needs: (m: string, p: string) => boolean) => string[];
  const checkR = checkRules as Rules;

  it('真名单和真 needsVersionCheck 通过', () => {
    expect(checkR(EXEMPT_RULES, needsVersionCheck)).toEqual([]);
  });

  it('违规样例：免查规则里加回存储签名、把 /files 写进规则 → 报错', () => {
    const bad = [...EXEMPT_RULES, { method: 'POST', path: '/storage/v1/object/sign/' }, { method: 'PUT', path: '/files/v1/o/' }];
    expect(checkR(bad, needsVersionCheck)).toHaveLength(2);
  });

  it('违规样例：/files 的 PUT 不查 → 报错', () => {
    const lax = (m: string, p: string) => (p.startsWith('/files/') ? false : needsVersionCheck(m, p));
    expect(checkR(EXEMPT_RULES, lax).some((e) => e.includes('PUT /files/v1/o/images'))).toBe(true);
  });
});
