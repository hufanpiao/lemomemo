// platform/files.ts 测试共用的假 fetch 和样例路径（不是测试文件本身；files.test.ts、files-sign.test.ts 用）
import { vi } from 'vitest';
import { createFilesClient } from '../files.ts';

export const BASE = 'https://lemomemo.com/files/v1/';
export const U = '0b7c6a1e-2d3f-4a5b-8c9d-0e1f2a3b4c5d';
export const N = '1b7c6a1e-2d3f-4a5b-8c9d-0e1f2a3b4c5d';
export const I = '2b7c6a1e-2d3f-4a5b-8c9d-0e1f2a3b4c5d';
export const IMG = `${U}/${N}/${I}.webp`;
export const PDF = `${U}/${N}/${I}.pdf`;
export const PPTX = `${U}/${N}/${I}.pptx`;

export type Call = { url: string; init: RequestInit };

export function fakeFetch(...responses: Array<Response | ((call: Call) => Response | Promise<Response>) | Error>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const r = responses.length > 1 ? responses.shift() : responses[0];
    if (r === undefined) throw new Error('fakeFetch：没有准备响应');
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(call) : r.clone();
  });
  return { fn, calls };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export function client(f: ReturnType<typeof fakeFetch>, token: string | null = 'jwt-a') {
  return createFilesClient({ base: BASE, fetch: f.fn as unknown as typeof fetch, getAccessToken: () => Promise.resolve(token), version: '4.0.0' });
}

export const signed = (bucket: string, path: string, e = 1_900_000_000, extra = '') => `${BASE}o/${bucket}/${path}?e=${e}&d=${extra}&s=abc_-123`;
