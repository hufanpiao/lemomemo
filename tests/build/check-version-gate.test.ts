// TC-B0-52：免查名单里写了不存在的函数，检查脚本报错
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error 构建脚本是 .mjs，没有类型声明
import { checkExemptFunctions } from '../../build/check_version_gate.mjs';

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
