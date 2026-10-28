// TC-B0-13（架构 16.3 B0 ①、R-66、R-74；QA 第二节“部分”）：manifest 的 start_url、scope 都是 /app/
// （SW 注册的 scope 由 tests/e2e/csp.spec.ts 核；主屏幕实际打开进 /app/ 是真机 P1-01）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'public', 'manifest.webmanifest'), 'utf8')) as Record<
  string,
  unknown
>;

describe('manifest.webmanifest', () => {
  it('start_url、scope 都是 /app/；独立窗口打开', () => {
    expect(manifest['start_url']).toBe('/app/');
    expect(manifest['scope']).toBe('/app/');
    expect(manifest['display']).toBe('standalone');
  });
});
