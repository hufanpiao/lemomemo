// 第一条契约测试：客户端发出的请求带 X-App-Version，本地 Supabase 正常应答（0.27 第 1 点）
// 版本过低回 426 的判断在转发层（前端 B 的 functions/sb/），那边的用例由 B 加；这里只证明框架能跑
import { describe, expect, it } from 'vitest';
import { APP_VERSION_HEADER, withAppVersion } from '../../src/platform/http.ts';
import { contract, COMPAT_IDS, localSupabase, registeredIds, subsetOnly } from './harness.ts';

contract('headers.app-version', '带版本头访问 REST 根路径，应答不是 5xx', async (sb) => {
  const res = await fetch(`${sb.url}/rest/v1/`, {
    headers: withAppVersion({ apikey: sb.anonKey, Authorization: `Bearer ${sb.anonKey}` }, '4.0.0'),
  });
  expect(res.status).toBeLessThan(500);
});

contract('headers.app-version-preview', '预览版号（4.0.0-preview.1）也能正常访问', async (sb) => {
  const res = await fetch(`${sb.url}/rest/v1/`, {
    headers: withAppVersion({ apikey: sb.anonKey, Authorization: `Bearer ${sb.anonKey}` }, '4.0.0-preview.1'),
  });
  expect(res.status).toBeLessThan(500);
});

describe('契约测试框架自测（不需要数据库）', () => {
  it('subset.json 里的 id 都登记过、不重复', () => {
    expect(new Set(COMPAT_IDS).size).toBe(COMPAT_IDS.length);
    for (const id of COMPAT_IDS) expect(registeredIds()).toContain(id);
  });

  it('localSupabase 读环境变量；缺一个就是 null', () => {
    expect(localSupabase({})).toBeNull();
    expect(localSupabase({ API_URL: 'http://127.0.0.1:54321' })).toBeNull();
    expect(localSupabase({ API_URL: 'http://127.0.0.1:54321', ANON_KEY: 'k' })).toEqual({
      url: 'http://127.0.0.1:54321',
      anonKey: 'k',
    });
  });

  it('LEMO_COMPAT_SUBSET=1 才进子集模式', () => {
    expect(subsetOnly({})).toBe(false);
    expect(subsetOnly({ LEMO_COMPAT_SUBSET: '1' })).toBe(true);
  });

  it('版本头名字和转发层约定一致', () => {
    expect(APP_VERSION_HEADER).toBe('X-App-Version');
  });
});
