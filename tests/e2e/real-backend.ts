// e2e 真后端那组的共用夹具（需求记录 R-255，接手清单 E2E-REAL 第 4 步）：建账号、免发信登录、从 Mailpit 取验证码
//
// 地址和密钥只从环境变量取，由 playwright.real.config.ts 在加载时用 tools/e2e/real-backend.mjs 的 statusEnv() 填好：
//   LEMO_E2E_SB_API          lemo-e2e 的 API（http://127.0.0.1:55321），admin 接口、service role 直连 PostgREST 用
//   LEMO_E2E_SB_ANON_KEY     anon key（经 /sb 换会话、页面里打 REST 用）
//   LEMO_E2E_SB_SERVICE_KEY  service role key（只在测试进程里用，不进页面）
//   LEMO_E2E_MAILPIT_URL     Mailpit（http://127.0.0.1:55324），只给 TC-B1-16、17 那两条真发信的用例
// 没设就直接抛错，不默认任何地址——不会去连 127.0.0.1:54321 / 54324（那是本机别人在用的 lemomemo）。
// 护栏（assertLocalBackendUrl，白名单）：主机只许 127.0.0.1，端口只许 55321、55324、8789；其余（包括本机别人那几套的 543xx、583xx）一律抛错。
// 值一律不打印（不进断言消息、不进 console）。
// 这个文件不起子进程：无后端组（playwright.config.ts）也会 import 它（b1-login-ua、b1-row-level 里 fixme 着的用例），import 时什么也不连。
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export const REAL_ENV = {
  api: 'LEMO_E2E_SB_API',
  anonKey: 'LEMO_E2E_SB_ANON_KEY',
  serviceKey: 'LEMO_E2E_SB_SERVICE_KEY',
  mailpit: 'LEMO_E2E_MAILPIT_URL',
} as const;

/**
 * 地址白名单（审查建议，10-30）：只许 http://127.0.0.1 加下面这几个实际用到的端口——
 * 55321 lemo-e2e 的 API、55324 lemo-e2e 的 Mailpit、8789 真后端组的 wrangler pages dev。其余一律拒（543xx、583xx 当然也在内）
 */
export const ALLOWED_PORTS: readonly number[] = [55321, 55324, 8789];

/** 地址护栏：协议 http、主机 127.0.0.1、端口在 ALLOWED_PORTS 里；不合格抛错（消息里只有主机和端口，不带路径和查询串） */
export function assertLocalBackendUrl(raw: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${what} 不是合法的地址`);
  }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') {
    throw new Error(`${what} 只许 http://127.0.0.1（现在是 ${u.protocol}//${u.host}）`);
  }
  if (!ALLOWED_PORTS.includes(Number(u.port)) || !/^\d+$/.test(u.port)) {
    throw new Error(`${what} 的端口 ${u.port || '（没写）'} 不在白名单里：只许 ${ALLOWED_PORTS.join('、')}（lemo-e2e 的 API、Mailpit 和 8789）；543xx、583xx 是本机别人在用的本地 Supabase`);
  }
  return u;
}

/** lemo-e2e 固定的两个地址（real-backend.mjs 的端口改写表：api 55321、local_smtp 55324） */
export const E2E_API_ORIGIN = 'http://127.0.0.1:55321';
export const E2E_MAILPIT_ORIGIN = 'http://127.0.0.1:55324';

/**
 * playwright.real.config.ts 每次加载都调（不管环境变量是不是已经设好）：API、SUPABASE_UPSTREAM 必须正好是 http://127.0.0.1:55321，
 * Mailpit 必须正好是 http://127.0.0.1:55324（只认源，不许带路径）；不对就抛错。值不进消息
 */
export function assertE2eOrigins(e: { api: string; mailpit: string; upstream: string }): void {
  const exact = (raw: string, origin: string, what: string) => {
    const u = assertLocalBackendUrl(raw, what);
    if (u.origin !== origin || (u.pathname !== '/' && u.pathname !== '') || u.search !== '') {
      throw new Error(`${what} 必须正好是 ${origin}（现在是 ${u.host}${u.pathname === '/' ? '' : '，还带了路径'}）`);
    }
  };
  exact(e.api, E2E_API_ORIGIN, REAL_ENV.api);
  exact(e.upstream, E2E_API_ORIGIN, 'SUPABASE_UPSTREAM');
  exact(e.mailpit, E2E_MAILPIT_ORIGIN, REAL_ENV.mailpit);
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `没设 ${name}：真后端用例只能经 npm run e2e:real 跑（playwright.real.config.ts 用 statusEnv() 填好环境变量）；` +
        '专用后端先用 npm run e2e:real:up 起。不默认连本机 54321/54324',
    );
  }
  return v;
}

export interface RealBackend {
  api: URL;
  anonKey: string;
  serviceKey: string;
}

/** 读环境变量并过护栏；任何一项不合格都抛错，不发请求 */
export function realBackend(): RealBackend {
  return {
    api: assertLocalBackendUrl(need(REAL_ENV.api), REAL_ENV.api),
    anonKey: need(REAL_ENV.anonKey),
    serviceKey: need(REAL_ENV.serviceKey),
  };
}

/** 用 service role 直连 lemo-e2e（不经 /sb）：只给建账号、补 profiles 行这类准备步骤用 */
async function admin(path: string, init: { method: string; body?: unknown; prefer?: string }): Promise<Response> {
  const b = realBackend();
  const url = new URL(path, b.api);
  if (url.origin !== b.api.origin) throw new Error('admin 请求只许发到 LEMO_E2E_SB_API');
  const headers: Record<string, string> = {
    apikey: b.serviceKey,
    Authorization: `Bearer ${b.serviceKey}`,
    'Content-Type': 'application/json',
  };
  if (init.prefer) headers['Prefer'] = init.prefer;
  return fetch(url, { method: init.method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
}

/** 出错时只报状态码和服务器的错误码字段，不带响应全文（免得把令牌、链接带进日志） */
async function failMsg(what: string, r: Response): Promise<string> {
  let code = '';
  try {
    const j = (await r.json()) as { code?: unknown; error_code?: unknown; msg?: unknown; message?: unknown };
    code = [j.error_code, j.code, j.msg, j.message].filter((x) => typeof x === 'string' || typeof x === 'number').join(' / ');
  } catch {
    // 不是 JSON：只报状态码
  }
  return `${what}失败：HTTP ${r.status}${code ? `（${code}）` : ''}`;
}

export interface Account {
  email: string;
  userId: string;
}

/**
 * 建一个测试账号：admin 接口建用户（[auth] enable_signup = false，不能注册），邮箱 e2e-<随机>@lemomemo.test（架构第 9 节护栏 ①）；
 * 再用 service role 补一行 profiles {user_id, ui_locale}——迁移里没有建 profiles 的触发器，没这行 record_consent 等会回 account_disabled。
 * consentPolicyVer（TC-B1-11 ③ ④，10-30）：给了就同一次 POST 写进 profiles.consent_policy_ver（模拟“看过某一版告知”）；不给就留空（first）
 */
export async function createAccount(opts: { uiLocale?: 'zh-CN' | 'ko-KR'; consentPolicyVer?: string } = {}): Promise<Account> {
  const email = `e2e-${randomUUID().slice(0, 8)}@lemomemo.test`;
  const u = await admin('/auth/v1/admin/users', { method: 'POST', body: { email, email_confirm: true } });
  if (u.status !== 200) throw new Error(await failMsg('建用户', u));
  const userId = ((await u.json()) as { id?: unknown }).id;
  if (typeof userId !== 'string') throw new Error('建用户的回包里没有 id');
  const p = await admin('/rest/v1/profiles', {
    method: 'POST',
    body: {
      user_id: userId,
      ui_locale: opts.uiLocale ?? 'zh-CN',
      ...(opts.consentPolicyVer === undefined ? {} : { consent_policy_ver: opts.consentPolicyVer }),
    },
    prefer: 'return=minimal',
  });
  if (p.status !== 201) throw new Error(await failMsg('补 profiles 行', p));
  return { email, userId };
}

/** lemo-e2e 里 app_config.notice 的两个版本号（只读；用例按它算“看过同一版”“版本更旧”，不写死日期） */
export interface NoticeVersions {
  policyVer: string;
  minConsentVer: string | null;
}

/** 用 service role 读 app_config.notice 的 policy_ver、min_consent_ver（只读，不改全局配置；E2E-REAL TC-B1-11 ③ ④，10-30） */
export async function readNotice(): Promise<NoticeVersions> {
  const r = await admin('/rest/v1/app_config?select=notice&id=eq.1', { method: 'GET' });
  if (r.status !== 200) throw new Error(await failMsg('读 app_config.notice', r));
  const rows = (await r.json()) as { notice?: { policy_ver?: unknown; min_consent_ver?: unknown } | null }[];
  const n = rows[0]?.notice;
  if (rows.length !== 1 || typeof n?.policy_ver !== 'string') throw new Error('app_config.notice.policy_ver 读不出来');
  return { policyVer: n.policy_ver, minConsentVer: typeof n.min_consent_ver === 'string' ? n.min_consent_ver : null };
}

/**
 * supabase-js 在 localStorage 里存会话的键：`sb-<supabaseUrl 主机名第一段>-auth-token`（同 src/platform/session.ts 的 sessionStorageKey）。
 * e2e-real 构建的 supabaseUrl 是 http://127.0.0.1:8789/sb，所以是 sb-127-auth-token
 */
export function sessionKeyFor(supabaseUrl: string): string {
  const first = new URL(supabaseUrl).hostname.split('.')[0];
  if (!first) throw new Error('supabaseUrl 读不出主机名');
  return `sb-${first}-auth-token`;
}

/** 写进 localStorage 的会话（supabase-js v2 _saveSession 存的整个 Session 对象） */
export interface StoredSession {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  user: { id: string; email?: string };
}

/**
 * 免发信登录：auth.admin.generateLink({type:'magiclink'}) 拿 email_otp（直连 admin 接口，不发信），
 * 再经本页同源的 /sb/auth/v1/verify（和 App 走同一条转发路）换成会话，按 supabase-js 的键名和格式写进页面 localStorage。
 * 写完停在同源的 /robots.txt 上（不在 /app/ 作用域，不起 App、不碰 SW），调用方自己 goto 要打开的页面（App 启动时读到会话就当已登录）。
 * 验证码、令牌都不打印、不截图；返回会话给调用方在页面里打 REST 用
 */
export async function loginViaOtp(page: Page, email: string): Promise<StoredSession> {
  const b = realBackend();
  const link = await admin('/auth/v1/admin/generate_link', { method: 'POST', body: { type: 'magiclink', email } });
  if (link.status !== 200) throw new Error(await failMsg('generate_link', link));
  const lj = (await link.json()) as { email_otp?: unknown; properties?: { email_otp?: unknown } };
  const otp = lj.email_otp ?? lj.properties?.email_otp;
  if (typeof otp !== 'string' || otp === '') throw new Error('generate_link 的回包里没有 email_otp');

  // 先到同源的静态文件上（不跑 App），localStorage 才写得进这个源
  await page.goto('/robots.txt');
  const origin = new URL(page.url()).origin;
  assertLocalBackendUrl(origin, '页面地址');
  const v = await page.request.post(`${origin}/sb/auth/v1/verify`, {
    headers: { apikey: b.anonKey, 'Content-Type': 'application/json' },
    data: { type: 'email', email, token: otp },
  });
  if (v.status() !== 200) throw new Error(`经 /sb 换会话失败：HTTP ${v.status()}`);
  const s = (await v.json()) as Partial<StoredSession>;
  if (typeof s.access_token !== 'string' || typeof s.refresh_token !== 'string' || typeof s.user?.id !== 'string') {
    throw new Error('/sb/auth/v1/verify 的回包不像会话');
  }
  const session: StoredSession = {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    token_type: s.token_type ?? 'bearer',
    expires_in: s.expires_in ?? 3600,
    expires_at: s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600),
    user: s.user,
  };
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: sessionKeyFor(`${origin}/sb`), value: JSON.stringify(session) },
  );
  return session;
}

/**
 * 本机 Mailpit 里取最新一封给 email 的 6 位验证码（只给 TC-B1-16、17 那两条真发信的用例；别的用例用 loginViaOtp，不发信）。
 * 地址过护栏；不打印验证码
 */
export async function otpFromMailpit(email: string): Promise<string> {
  const base = assertLocalBackendUrl(need(REAL_ENV.mailpit), REAL_ENV.mailpit);
  let id = '';
  await expect
    .poll(
      async () => {
        const r = await fetch(new URL(`/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`, base));
        const j = (await r.json()) as { messages?: { ID: string }[] };
        id = j.messages?.[0]?.ID ?? '';
        return id;
      },
      { timeout: 15_000 },
    )
    .not.toBe('');
  const msg = (await (await fetch(new URL(`/api/v1/message/${encodeURIComponent(id)}`, base))).json()) as { Text?: string };
  const code = /\b(\d{6})\b/.exec(msg.Text ?? '')?.[1];
  expect(code, '邮件里有 6 位验证码').toBeTruthy();
  return code ?? '';
}

/** 在页面里带本页会话的 access token 经同源 /sb 打 REST（和 App 走同一条路）；token 从 localStorage 读，不经测试进程打印 */
export async function restInPage(page: Page, method: string, path: string, data?: unknown): Promise<{ status: number; body: unknown }> {
  const anon = realBackend().anonKey;
  return page.evaluate(
    async ({ method, path, data, anon }) => {
      const key = Object.keys(localStorage).find((k) => /^sb-.+-auth-token$/.test(k)) ?? '';
      const token = (JSON.parse(localStorage.getItem(key) ?? '{}') as { access_token?: string }).access_token ?? '';
      const headers: Record<string, string> = {
        apikey: anon,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-App-Version': '4.0.0',
        Prefer: 'return=representation',
      };
      const r = await fetch(`/sb${path}`, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const text = await r.text();
      return { status: r.status, body: text ? (JSON.parse(text) as unknown) : null };
    },
    { method, path, data, anon },
  );
}

/** fnInPage 的结果：JSON 回包原样给；gzip 的导出包在页面里解开，只带回包头几个字段（不把整包数据搬进测试进程） */
export interface FnResult {
  status: number;
  contentType: string;
  json: unknown;
  exportHead: { format?: unknown; version?: unknown; user_id?: unknown; vault?: unknown } | null;
}

/**
 * 在页面里经同源 /sb 调边缘函数（POST /sb/functions/v1/<fn>），X-App-Version 由调用方指定（TC-B1-63 要用低版本）。
 * 会话令牌从本页 localStorage 读，不经测试进程打印。E2E-REAL 第 6 步新加（10-30）
 */
export async function fnInPage(page: Page, fn: string, body: unknown, opts: { version: string }): Promise<FnResult> {
  if (!/^[a-z][a-z0-9-]*$/.test(fn)) throw new Error(`函数名不认：${fn}`);
  const anon = realBackend().anonKey;
  return page.evaluate(
    async ({ fn, body, anon, version }) => {
      const key = Object.keys(localStorage).find((k) => /^sb-.+-auth-token$/.test(k)) ?? '';
      const token = (JSON.parse(localStorage.getItem(key) ?? '{}') as { access_token?: string }).access_token ?? '';
      const r = await fetch(`/sb/functions/v1/${fn}`, {
        method: 'POST',
        headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-App-Version': version },
        body: JSON.stringify(body),
      });
      const contentType = r.headers.get('content-type') ?? '';
      if (contentType.startsWith('application/gzip')) {
        const text = await new Response(r.body?.pipeThrough(new DecompressionStream('gzip')) ?? null).text();
        const all = JSON.parse(text) as Record<string, unknown>;
        return { status: r.status, contentType, json: null, exportHead: { format: all['format'], version: all['version'], user_id: all['user_id'], vault: all['vault'] } };
      }
      const text = await r.text();
      let json: unknown = text;
      try {
        json = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        // 不是 JSON 就原文
      }
      return { status: r.status, contentType, json, exportHead: null };
    },
    { fn, body, anon, version: opts.version },
  );
}
