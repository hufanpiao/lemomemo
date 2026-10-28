// compat 机制的单元测试（TC-B0-57 的机制部分；真正对样例迁移跑一遍要本地 Supabase，CI 里由运维接）
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { modeFor, parseSubset, pickBaseline } from './run-compat.ts';

describe('pickBaseline', () => {
  it('没有 4.x 发布 tag 时用 compat-baseline（v3.0.0 不算）', () => {
    expect(pickBaseline(['v3.0.0', 'compat-baseline', 'v4.0.0-preview.3'])).toBe('compat-baseline');
    expect(pickBaseline(['compat-baseline', 'v4.0.0-preview.3'])).toBe('compat-baseline');
  });

  it('有多个发布 tag 取最高的（按数字比）', () => {
    expect(pickBaseline(['v4.0.0', 'v4.10.0', 'v4.9.1', 'compat-baseline'])).toBe('v4.10.0');
  });

  it('什么都没有返回 null（4.0.0 第一次跳过）', () => {
    expect(pickBaseline([])).toBeNull();
    expect(pickBaseline(['v4.0.0-preview.1', 'some-tag', 'v3.0.0'])).toBeNull();
  });
});

describe('modeFor', () => {
  it('上线前只报告，4.0.0 起必须通过', () => {
    expect(modeFor('compat-baseline')).toBe('report');
    expect(modeFor('v3.0.0')).toBe('report'); // v3 的测试不是 4.x 的契约
    expect(modeFor('v4.0.0')).toBe('enforce');
    expect(modeFor('v4.1.2')).toBe('enforce');
  });
});

describe('parseSubset', () => {
  it('仓库里的 subset.json 合法', () => {
    const text = readFileSync(new URL('./subset.json', import.meta.url), 'utf8');
    expect(parseSubset(text).version).toBe(1);
  });

  it('拒绝坏路径', () => {
    for (const f of ['/etc/passwd', 'tests/../x.test.ts', 'src/a.test.ts', 'tests/a.ts']) {
      expect(() => parseSubset(JSON.stringify({ version: 1, files: [f] }))).toThrow();
    }
    expect(() => parseSubset('{"version":2,"files":[]}')).toThrow();
  });

  it('接受契约用例路径', () => {
    expect(parseSubset('{"version":1,"files":["tests/contract/pull.test.ts"]}').files).toEqual(['tests/contract/pull.test.ts']);
  });
});
