// build/ci/npm_audit_gate.mjs：npm audit 高危按 osv-scanner.toml 豁免放行（11-18 picomatch 无修复版，负责人同意）
// 没豁免、豁免过期、读不出编号的一律拦下；不联网、不起子进程
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blocked, highOf, ignoresOf } from '../../build/ci/npm_audit_gate.mjs';

const report = {
  vulnerabilities: {
    picomatch: { via: [{ severity: 'high', title: 'ReDoS', url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf' }] },
    vite: { via: ['picomatch'] },
    foo: { via: [{ severity: 'moderate', title: '中危不管', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }] },
  },
};

describe('npm audit 关口', () => {
  it('只取高危、严重的通告，按 GHSA 编号去重；字符串形式的 via（转引）不重复算', () => {
    expect(highOf(report)).toEqual([{ id: 'GHSA-fc5q-39xc-vjpf', pkg: 'picomatch', title: 'ReDoS' }]);
  });

  it('豁免在且没过期才放行；过期、没写、读不出编号都拦下', () => {
    const found = highOf(report);
    expect(blocked(found, new Map([['GHSA-fc5q-39xc-vjpf', '2026-12-18']]), '2026-11-18')).toEqual([]);
    expect(blocked(found, new Map([['GHSA-fc5q-39xc-vjpf', '2026-12-18']]), '2026-12-19')).toHaveLength(1);
    expect(blocked(found, new Map(), '2026-11-18')).toHaveLength(1);
    const noId = highOf({ vulnerabilities: { x: { via: [{ severity: 'critical', title: '没有链接' }] } } });
    expect(noId[0].id).toBeNull();
    expect(blocked(noId, new Map([['GHSA-fc5q-39xc-vjpf', '2099-01-01']]), '2026-11-18')).toHaveLength(1);
  });

  it('读得出仓库里真的 osv-scanner.toml：picomatch 这条在，到期日 2026-12-18', () => {
    const m = ignoresOf(readFileSync('osv-scanner.toml', 'utf8'));
    expect(m.get('GHSA-fc5q-39xc-vjpf')).toBe('2026-12-18');
    expect(m.size).toBeGreaterThan(5);
  });
});
