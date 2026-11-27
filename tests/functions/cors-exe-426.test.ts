// TC-B6X-22：转发层本地生成的 426（升级提示）带 exe 的 CORS 头，exe 才读得到响应体、弹升级横幅（B6-exe F5 ③；架构 5.10）。
// B0 已经在 functions/sb/[[path]].ts、functions/files/[[path]].ts 经 applyCors 做了，这里按 exe 来源、别的来源、没有来源三种逐条核对；
// 顺带核对 F5 ②：预检放行的请求头里没有 0.32 起不用的 x-upsert、cache-control。
import { describe, expect, it } from 'vitest';
import { handleSb } from '../../functions/sb/[[path]].ts';
import { ALLOW_HEADERS, EXE_ORIGIN, EXPOSE_HEADERS, FILES_ALLOW_HEADERS } from '../../functions/_lib/cors.ts';
import { BASE, ENV, setup as sbSetup } from './sb-harness.ts';
import { IMG, put, setup as filesSetup } from './files-harness.ts';
import { webp } from './files-fakes.ts';

const OTHER = 'https://evil.example';

function sb426(origin: string | null): Promise<Response> {
  const s = sbSetup({ min: '4.0.0' });
  const headers: Record<string, string> = {};
  if (origin !== null) headers.Origin = origin;
  return handleSb(new Request(BASE + '/sb/rest/v1/todos?id=eq.1', { method: 'PATCH', body: '{}', headers }), ENV, s.deps);
}

function files426(origin: string | null): Promise<Response> {
  const s = filesSetup({ min: '4.1.0' });
  return s.call(put(IMG, webp(100), origin === null ? {} : { origin }));
}

describe.each([
  ['/sb/*', sb426],
  ['/files/*', files426],
])('TC-B6X-22：%s 的 426', (_name, make) => {
  it('exe 来源：Allow-Origin 精确是 exe 来源、暴露头齐全、Vary 带 Origin，响应体是 upgrade_required', async () => {
    const r = await make(EXE_ORIGIN);
    expect(r.status).toBe(426);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(EXE_ORIGIN);
    expect((r.headers.get('Access-Control-Expose-Headers') ?? '').split(', ')).toEqual([...EXPOSE_HEADERS]);
    expect(r.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect((r.headers.get('Vary') ?? '').toLowerCase()).toContain('origin');
    expect(((await r.json()) as { code: string }).code).toBe('upgrade_required');
  });

  it.each([
    ['别的来源', OTHER],
    ['没有来源（网页版同源）', null],
  ])('%s：不带任何 Access-Control-* 头，但 Vary 带 Origin（缓存不串）', async (_label, origin) => {
    const r = await make(origin);
    expect(r.status).toBe(426);
    expect([...r.headers.keys()].filter((k) => k.toLowerCase().startsWith('access-control-'))).toEqual([]);
    expect((r.headers.get('Vary') ?? '').toLowerCase()).toContain('origin');
  });
});

describe('F5 ②：预检不再放行 x-upsert、cache-control', () => {
  it('/sb 和 /files 的允许请求头里都没有', async () => {
    for (const list of [ALLOW_HEADERS, FILES_ALLOW_HEADERS]) {
      expect(list).not.toContain('x-upsert');
      expect(list).not.toContain('cache-control');
    }
    const s = sbSetup();
    const r = await handleSb(new Request(BASE + '/sb/rest/v1/todos', { method: 'OPTIONS', headers: { Origin: EXE_ORIGIN } }), ENV, s.deps);
    const allow = (r.headers.get('Access-Control-Allow-Headers') ?? '').split(', ');
    expect(allow).not.toContain('x-upsert');
    expect(allow).not.toContain('cache-control');
  });
});
