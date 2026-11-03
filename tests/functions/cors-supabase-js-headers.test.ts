// B6-exe F5 ①（架构 5.10“以 B0 锁定版本的 supabase-js 抓包为准”）：拦截 fetch，不连任何服务器，记下 supabase-js 各部分
// （auth、PostgREST、functions）在 App 用到的调用里发出的请求头。凡是不在 CORS 安全名单里的（要预检的），都必须在
// functions/_lib/cors.ts 的 ALLOW_HEADERS 里——否则 exe（http://tauri.localhost 跨域）的那次请求卡在预检。
// supabase-js 升级时这条会把新加的头抓出来。storage-js（0.32 起客户端不用）、Realtime（WebSocket 不走 CORS）不在范围内。
// 响应头也抓（B6-exe 代码审查 M3）：假 fetch 返回的 Response 换上会记账的 Headers，记下 supabase-js 和 App 的 appFetch 实际读过哪些响应头；
// 去掉 CORS 安全响应头以后钉成清单，并断言都在 EXPOSE_HEADERS 里，或者是架构 0.54 写明不暴露的那几个。
// 客户端用 App 自己的 clientOptions()（审查 S4 ①）：App 以后改选项这里也跟着变。fetch 走 App 的 appFetch → 全局 fetch，
// 所以全局 fetch 换成抓包替身（不联网）；“有没有哪个库绕开传进去的 fetch”改成断言每个请求都带 X-App-Version（只有经过 appFetch 才带，S4 ②）
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ALLOW_HEADERS, EXPOSE_HEADERS } from '../../functions/_lib/cors.ts';

// App 的 clientOptions 动态加载、路径放在常量里（后端代码审查复核 N1）：静态 import 会把 src/platform/env.ts（import.meta.env）、
// auth-storage.ts（localStorage）带进 Workers 的 tsconfig.functions.json，typecheck 多出几十个错误。写法同 account-export-p0-auth.test.ts
interface ClientModule {
  clientOptions(version?: string): {
    global: { headers: Record<string, string>; fetch: typeof fetch };
    auth: Record<string, unknown>;
  };
}
const CLIENT_PATH = '../../src/platform/supabase/client.ts';
const { clientOptions } = (await import(/* @vite-ignore */ CLIENT_PATH)) as ClientModule;

/** Fetch 规范的 CORS 安全请求头（值也安全时不预检；content-type 的 application/json 要预检，ALLOW_HEADERS 里本来就有） */
const SAFELISTED = new Set(['accept', 'accept-language', 'content-language', 'content-type', 'range']);
/** Fetch 规范的 CORS 安全响应头（跨域不暴露也读得到） */
const SAFE_RESPONSE = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);
/** 架构 0.54 第 1 条写明不暴露的：functions-js 的 x-relay-error（只影响报错类名）；auth 管理接口的 link、x-total-count（App 不用） */
const NOT_EXPOSED_BY_DECISION = new Set(['x-relay-error', 'link', 'x-total-count']);

/** 读过的非安全响应头，钉成清单（升级 supabase-js、改 appFetch 时有变化就在这里报出来） */
const UNSAFE_READ: string[] = [
  'content-range', // postgrest-js：计数、分页
  'date', // App 的 appFetch：时钟偏差（4.3）
  'retry-after', // postgrest-js：503 重试前等多久（0.54）
  'x-relay-error', // functions-js：函数报错时定报错类名（0.54 写明不暴露）
  'x-supabase-api-version', // auth-js：出错的响应按版本解析报错码
];

const SESSION = {
  // 假会话令牌：头、签名各一个字符，载荷是全 0 测试用户；运行时拼，源码里不出现 JWT 字面量（免 gitleaks 误报）
  access_token: `h.${Buffer.from(JSON.stringify({ sub: '00000000-0000-0000-0000-000000000001', exp: 4102444800, session_id: 's' })).toString('base64url')}.s`,
  refresh_token: 'r',
  expires_in: 3600,
  expires_at: 4102444800,
  token_type: 'bearer',
  user: { id: '00000000-0000-0000-0000-000000000001', email: 'a@b.test', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
};

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** 读了 Headers 的哪些名字：get、has 记名字；整体遍历记成 '*'（遍历就等于什么都可能读） */
class TrackedHeaders extends Headers {
  readonly #note: (name: string) => void;
  constructor(init: HeadersInit, note: (name: string) => void) {
    super(init);
    this.#note = note;
  }
  override get(name: string): string | null {
    this.#note(name.toLowerCase());
    return super.get(name);
  }
  override has(name: string): boolean {
    this.#note(name.toLowerCase());
    return super.has(name);
  }
  override forEach(cb: (value: string, key: string, parent: Headers) => void, thisArg?: unknown): void {
    this.#note('*');
    super.forEach(cb, thisArg);
  }
  override entries(): ReturnType<Headers["entries"]> {
    this.#note('*');
    return super.entries();
  }
  override keys(): ReturnType<Headers["keys"]> {
    this.#note('*');
    return super.keys();
  }
  override values(): ReturnType<Headers["values"]> {
    this.#note('*');
    return super.values();
  }
  override [Symbol.iterator](): ReturnType<Headers["entries"]> {
    this.#note('*');
    return super[Symbol.iterator]();
  }
}

/** Response 换上记账的 headers；clone() 出来的也记账 */
function tracked(res: Response, note: (name: string) => void): Response {
  const h = new TrackedHeaders(res.headers, note);
  const clone = res.clone.bind(res);
  Object.defineProperty(res, 'headers', { value: h });
  Object.defineProperty(res, 'clone', { value: () => tracked(clone(), note) });
  return res;
}

interface Captured {
  /** 请求头名 → 哪几步发过 */
  sent: Map<string, Set<string>>;
  /** 响应头名 → 哪几步读过 */
  read: Map<string, Set<string>>;
  /** 每个请求有没有 x-app-version（经过 appFetch） */
  viaAppFetch: boolean[];
}

const add = (m: Map<string, Set<string>>, k: string, label: string) => {
  const s = m.get(k) ?? new Set<string>();
  s.add(label);
  m.set(k, s);
};

/** 每个响应都带上的头：上游 Supabase 常见的那几个，看 supabase-js 读哪些 */
const UPSTREAM_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'content-range': '0-0/1',
  date: 'Tue, 03 Nov 2026 00:00:00 GMT',
  'x-supabase-api-version': '2024-01-01',
  'x-relay-error': 'false',
  link: '</x>; rel="next"',
  'x-total-count': '1',
  'sb-request-id': 'r',
};

async function capture(): Promise<Captured> {
  const out: Captured = { sent: new Map(), read: new Map(), viaAppFetch: [] };
  let label = '';
  let reply: () => Reply = () => ({ status: 200, body: {} });
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    for (const [k] of req.headers) add(out.sent, k, label);
    out.viaAppFetch.push(req.headers.has('x-app-version'));
    const r = reply();
    const res = new Response(r.body === null ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { ...UPSTREAM_HEADERS, ...(r.headers ?? {}) },
    });
    const at = label;
    return tracked(res, (name) => add(out.read, name, at));
  };
  vi.stubGlobal('fetch', fakeFetch);
  const opts = clientOptions('4.0.0');
  const db = createClient('https://lemomemo.com/sb', 'anon-key', {
    ...opts,
    // 抓包时不自动刷新令牌（不让后台计时器插进别的步骤）；其余照 App 的选项
    auth: { ...opts.auth, autoRefreshToken: false },
  });
  const step = async (name: string, fn: () => PromiseLike<unknown>, r?: () => Reply) => {
    label = name;
    reply = r ?? (() => ({ status: 200, body: {} }));
    await fn();
  };
  const session = () => ({ status: 200, body: SESSION });
  await step('auth.signInWithOtp', () => db.auth.signInWithOtp({ email: 'a@b.test', options: { shouldCreateUser: false, captchaToken: 't' } }));
  await step('auth.verifyOtp', () => db.auth.verifyOtp({ email: 'a@b.test', token: '123456', type: 'email' }), session);
  // auth-js 只在出错的响应上读 X-Supabase-Api-Version（按版本解析报错码）
  await step('auth.error', () => db.auth.verifyOtp({ email: 'a@b.test', token: '000000', type: 'email' }), () => ({
    status: 403,
    body: { code: 'otp_expired', msg: 'expired' },
  }));
  await step('auth.getUser', () => db.auth.getUser(), () => ({ status: 200, body: SESSION.user }));
  await step('auth.refreshSession', () => db.auth.refreshSession(), session);
  await step('auth.updateUser', () => db.auth.updateUser({ data: { a: 1 } }), () => ({ status: 200, body: SESSION.user }));
  await step('rest.select', () => db.from('todos').select('*').order('id').limit(5));
  await step('rest.count', () => db.from('todos').select('*', { count: 'exact', head: true }));
  await step('rest.single', () => db.from('todos').select('*').eq('id', 'x').single(), () => ({ status: 200, body: { id: 'x' } }));
  await step('rest.insert', () => db.from('todos').insert({ id: 'x' }).select());
  await step('rest.upsert', () => db.from('todos').upsert({ id: 'x' }, { onConflict: 'id', ignoreDuplicates: true }));
  await step('rest.update', () => db.from('todos').update({ a: 1 }).eq('id', 'x'));
  await step('rest.delete', () => db.from('todos').delete().eq('id', 'x'));
  await step('rest.rpc', () => db.rpc('apply_patch', { p: 1 }));
  let n = 0;
  // GET 遇到 503 自己重试：Retry-After: 0 让它马上重试，看重试那次带的头
  await step('rest.retry', () => db.from('todos').select('*'), () => (n++ === 0 ? { status: 503, body: {}, headers: { 'retry-after': '0' } } : { status: 200, body: [] }));
  await step('fn.invoke', () => db.functions.invoke('account', { body: { action: 'restore' }, headers: { 'x-tz': 'Asia/Seoul' } }));
  // 函数报错时 functions-js 读 x-relay-error 定报错类名（0.54 写明不暴露）
  await step('fn.invoke.error', () => db.functions.invoke('account', { body: { action: 'restore' } }), () => ({ status: 500, body: { code: 'x' } }));
  await step('auth.signOut', () => db.auth.signOut({ scope: 'local' }), () => ({ status: 204, body: null }));
  return out;
}

let captured: Captured;
beforeAll(async () => {
  captured = await capture();
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('F5 ①：按锁定版本的 supabase-js 抓请求头和响应头，对照 5.10 的表', () => {
  it('要预检的请求头全在 ALLOW_HEADERS 里；抓到的清单钉住（升级 supabase-js 时有变化就会在这里报出来）', () => {
    const seen = captured.sent;
    const needPreflight = [...seen.keys()].filter((k) => !SAFELISTED.has(k)).sort();
    expect(needPreflight).toEqual([
      'accept-profile',
      'apikey',
      'authorization',
      'content-profile',
      'prefer',
      'x-app-version',
      'x-client-info',
      'x-retry-count', // 5.10 表里原来没有（F5 ① 抓到）：postgrest-js 重试那次带
      'x-supabase-api-version',
      'x-tz',
    ]);
    const allowed = new Set(ALLOW_HEADERS.map((h) => h.toLowerCase()));
    expect(needPreflight.filter((h) => !allowed.has(h))).toEqual([]);
    expect(seen.get('x-retry-count')).toEqual(new Set(['rest.retry']));
  });

  it('每个请求都经过 App 的 appFetch（带 X-App-Version）：没有哪个子库绕开传进去的 fetch（S4 ②）', () => {
    expect(captured.viaAppFetch.length).toBeGreaterThan(15);
    expect(captured.viaAppFetch.every(Boolean)).toBe(true);
  });

  it('响应头：supabase-js 和 appFetch 实际读过的非安全响应头钉成清单，都已暴露或是 0.54 写明不暴露的（M3）', () => {
    const read = captured.read;
    expect(read.has('*')).toBe(false); // 没有谁整体遍历响应头；以后有了，这里要重新看它读了什么
    const unsafe = [...read.keys()].filter((k) => !SAFE_RESPONSE.has(k)).sort();
    expect(unsafe).toEqual(UNSAFE_READ);
    const exposed = new Set(EXPOSE_HEADERS.map((h) => h.toLowerCase()));
    expect(unsafe.filter((h) => !exposed.has(h) && !NOT_EXPOSED_BY_DECISION.has(h))).toEqual([]);
    // 0.54 写明不暴露的，确实没有暴露（暴露了就该把 0.54 改掉）
    expect([...NOT_EXPOSED_BY_DECISION].filter((h) => exposed.has(h))).toEqual([]);
  });

  it('关键的几个响应头是在预期的步骤里读的', () => {
    expect(captured.read.get('retry-after')).toEqual(new Set(['rest.retry']));
    expect(captured.read.get('content-range')?.has('rest.count')).toBe(true);
  });
});
