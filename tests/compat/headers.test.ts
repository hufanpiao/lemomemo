// 第一条契约测试：客户端发出的请求带 X-App-Version，本地 Supabase 正常应答（0.27 第 1 点）
// 版本过低回 426 的判断在转发层（前端 B 的 functions/sb/），那边的用例在 tests/functions/
// 契约用例写死 4.0.0 客户端在线上发的东西（头名、版本号），不 import src/：基线那一版会被单独取出来跑（见 harness.ts）
import { describe, expect, it } from 'vitest';
import subsetJson from './subset.json' with { type: 'json' };
import { contract, COMPAT_IDS, localSupabase, registeredIds, subsetOnly } from './harness.ts';
import { parseSubset } from './subset.ts';

/** 4.0.0 客户端带的版本头（src/platform/http.ts 的 APP_VERSION_HEADER，单测另有核对） */
const HEADER = 'X-App-Version';

const headers = (anonKey: string, version: string) => ({
  apikey: anonKey,
  Authorization: `Bearer ${anonKey}`,
  [HEADER]: version,
});

contract('headers.app-version', '带版本头访问 REST 根路径，应答不是 5xx', async (sb) => {
  const res = await fetch(`${sb.url}/rest/v1/`, { headers: headers(sb.anonKey, '4.0.0') });
  expect(res.status).toBeLessThan(500);
});

contract('headers.app-version-preview', '预览版号（4.0.0-preview.1）也能正常访问', async (sb) => {
  const res = await fetch(`${sb.url}/rest/v1/`, { headers: headers(sb.anonKey, '4.0.0-preview.1') });
  expect(res.status).toBeLessThan(500);
});

describe('契约测试框架自测（不需要数据库）', () => {
  it('subset.json 里本文件的 id 都登记过', () => {
    const mine = parseSubset(subsetJson).cases.filter((c) => c.file === 'tests/compat/headers.test.ts').map((c) => c.id);
    expect(mine.length).toBeGreaterThan(0);
    for (const id of mine) expect(registeredIds()).toContain(id);
    expect(new Set(COMPAT_IDS).size).toBe(COMPAT_IDS.length);
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
});
