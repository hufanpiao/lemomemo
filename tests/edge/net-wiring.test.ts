// 服务器函数出站请求的接线核对：所有函数的 supabase-js（createClient）都经 _shared/net.ts 的 timedFetch，account-purge 的 R2 也经它。
// 读源码核对，放在 tests/edge（node 类型）；timedFetch 自己的行为在 tests/functions/shared-net.test.ts。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../arch/fixture-header.ts';

describe('接线：supabase-js 全部经 timedFetch；account-purge 的 R2 也经它', () => {
  const FN = join(ROOT, 'supabase', 'functions');
  const src = (fn: string) => readFileSync(join(FN, fn, 'index.ts'), 'utf8');
  /** supabase/functions 下的源码（不含生成目录 _shared/gen 和测试文件） */
  const sources = (dir: string, rel = ''): string[] => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return r === '_shared/gen' ? [] : sources(dir, r);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [r] : [];
  });
  it('每一处 createClient( 调用都带 global: { fetch: timedFetch(fetch, …) }（漏一处就红）', () => {
    const calls: string[] = [];
    const bad: string[] = [];
    for (const r of sources(FN)) {
      const code = readFileSync(join(FN, r), 'utf8');
      for (const m of code.matchAll(/\bcreateClient\(([^\n]*)/g)) {
        calls.push(r);
        if (!/global: \{ fetch: timedFetch\(fetch, [A-Z_]+\) \}/.test(m[1] ?? '')) bad.push(r);
      }
    }
    expect(bad).toEqual([]);
    expect(calls.length).toBeGreaterThanOrEqual(13);   // 真的扫到了（11-12 时 13 处）
  });
  it('account-purge：R2 客户端的 fetch 经 timedFetch', () => {
    expect(src('account-purge')).toMatch(/createObjStore\(\{[^}]*fetch: \(url, init\) => timedFetch\(fetch\)\(url, init as RequestInit\)/s);
  });
});
