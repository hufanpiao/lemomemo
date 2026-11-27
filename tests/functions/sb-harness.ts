// tests/functions/sb-*.test.ts 共用：环境（假值）、上游桩、造请求。
import { vi } from 'vitest';
import type { SbEnv } from '../../functions/sb/[[path]].ts';
import { createVersionGate } from '../../functions/sb/version-gate.ts';

export const ENV: SbEnv = {
  SUPABASE_UPSTREAM: 'https://abcdefghijklmnop.supabase.co',
  SUPABASE_ANON_KEY: 'anon-test',
  PROXY_SECRET: 'proxy-secret-test',
};

export function setup(opts: { min?: string; upstream?: (req: Request) => Promise<Response> } = {}) {
  const seen: Request[] = [];
  const log = vi.fn();
  const fetchStub = vi.fn(async (req: Request) => {
    seen.push(req);
    if (opts.upstream) return opts.upstream(req);
    return new Response('{"ok":true}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Content-Range': '0-0/1',
        'Set-Cookie': '__cf_bm=x; Domain=.supabase.co',
      },
    });
  });
  const gate = createVersionGate({ loadMin: async () => opts.min ?? '4.0.0' });
  /** 上游收到的第一个请求；没收到就让用例失败（不用非空断言） */
  const first = (): Request => {
    const r = seen[0];
    if (!r) throw new Error('上游没有收到请求');
    return r;
  };
  return { seen, first, log, fetchStub, deps: { fetch: fetchStub, gate, log } };
}

export const BASE = 'https://lemomemo.com';

export function req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
  return new Request(BASE + path, { ...init, headers: { 'X-App-Version': '4.0.0', ...(init.headers ?? {}) } });
}
