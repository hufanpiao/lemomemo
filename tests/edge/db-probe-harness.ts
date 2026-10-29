// tests/edge/db-probe*.test.ts 共用（B1 第九批从 db-probe.test.ts 拆出）：常量、假数据库（fakeDb）、假 HTTP 依赖（setup）、
// 造请求和调用 handle 的小工具、响应不泄露的检查，以及每条用例后还原真计时器的 afterEach。
// afterEach 写在这个模块顶层：引入它的测试文件加载时就注册上（vitest 默认每个测试文件各自加载一次模块），测试文件里不用再写。
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import { type Guard, handle, type HandlerDeps } from '../../supabase/functions/_preview/db-probe/handler.ts';
import {
  PREVIEW_REF, type ProbeDeps, type ProbeReport, type Query, type Session, type Tls, urlFacts,
} from '../../supabase/functions/_preview/db-probe/probe.ts';

export const ROOT = join(__dirname, '..', '..');
export const A = '11111111-2222-4333-8444-555555555555';
export const B = '99999999-8888-4777-8666-555555555555';
export const PREVIEW_URL = `https://${PREVIEW_REF}.supabase.co`;
export const T0 = Date.parse('2026-10-29T03:00:00Z');
// 假连接串：密码、主机名都是编的，只用来证明它们不进响应
export const SECRET_PW = 'Sup3rS3cretPw_do-not-echo';
export const POOL_HOST = 'aws-9-ap-northeast-2.pooler.supabase.com';
export const FAKE_URL = `postgresql://fn_ai.${PREVIEW_REF}:${SECRET_PW}@${POOL_HOST}:6543/postgres?sslmode=require`;

// ---------- 假数据库 ----------

export interface DbOpts {
  /** notes 表的行（只要 user_id） */
  notes?: string[];
  /** private.scan_embed_queue 的行（user_id） */
  queue?: string[];
  /** RLS 坏了：不管 app.uid，notes 全部可见 */
  rlsBroken?: boolean;
  /** app.uid 跨事务串：同一条自开连接上，上一个事务设的值下一个事务还在 */
  leak?: boolean;
  /** 各种连接方式连不上时抛的错（withUser / withScan 走 require） */
  fail?: Partial<Record<Tls | 'user' | 'scan', unknown>>;
  /** 永远不返回（测超时） */
  hang?: Partial<Record<Tls | 'user', true>>;
  /** current_user 返回什么（默认 fn_ai） */
  user?: string;
}

export function fakeDb(o: DbOpts = {}) {
  const notes = o.notes ?? [A, A, B];
  const queue = o.queue ?? [A, B, B];
  const log: string[] = [];
  const ended: Tls[] = [];
  const opened: Tls[] = [];
  const visible = (uid: string | null) => (o.rlsBroken ? notes : uid ? notes.filter((u) => u === uid) : []);

  // 一个事务：uid 是本事务的 app.uid
  const makeQuery = (state: { uid: string | null; onSet?: (u: string) => void }): Query => async (strings, ...values) => {
    const text = strings.join('$');
    log.push(text.replace(/\s+/g, ' ').trim());
    if (text.includes("set_config('statement_timeout'")) return [];
    if (text.includes("set_config('app.uid'")) {
      state.uid = String(values[0]);
      state.onSet?.(state.uid);
      return [];
    }
    if (text.includes('uid_set')) {
      const uid = String(values[0]);
      return [{ u: o.user ?? 'fn_ai', uid_set: state.uid === uid, n: visible(state.uid).length, other: visible(state.uid).filter((x) => x !== uid).length }];
    }
    if (text.includes('scan_embed_queue')) {
      return [{ u: o.user ?? 'fn_ai', uid_empty: !state.uid, q: queue.length, qu: new Set(queue).size, n: visible(state.uid).length }];
    }
    if (text.includes('uid_empty')) return [{ uid_empty: !state.uid, n: visible(state.uid).length }];
    if (text.includes('as n')) return [{ n: visible(state.uid).length }];
    if (text.includes('current_user::text as u')) return [{ u: o.user ?? 'fn_ai' }];
    if (text.includes('select 1 as one')) return [{ one: 1 }];
    throw new Error(`假数据库不认识这条 SQL：${text}`);
  };

  const never = new Promise<never>(() => undefined);

  const deps = (extra: Partial<ProbeDeps> = {}): ProbeDeps => ({
    url: urlFacts(FAKE_URL).facts,
    lemoProbePresent: false,
    withUser: async (uid, fn) => {
      if (o.hang?.user) return never;
      if (o.fail?.user) throw o.fail.user;
      return fn(makeQuery({ uid }));
    },
    withScan: async (fn) => {
      if (o.fail?.scan) throw o.fail.scan;
      return fn(makeQuery({ uid: null }));
    },
    open: (tls): Session => {
      opened.push(tls);
      let sticky: string | null = null;
      return {
        tx: async (fn) => {
          if (o.hang?.[tls]) return never;
          if (o.fail?.[tls]) throw o.fail[tls];
          return fn(makeQuery({ uid: o.leak ? sticky : null, onSet: (u) => (sticky = u) }));
        },
        end: async () => {
          ended.push(tls);
        },
      };
    },
    caFingerprint: null,
    clock: () => Date.now(),
    ...extra,
  });
  return { deps, log, opened, ended };
}

// ---------- 假 HTTP 依赖 ----------

export interface Setup {
  wall?: number;
  supabaseUrl?: string | undefined;
  db?: DbOpts;
  probe?: Partial<ProbeDeps>;
  guard?: 'ok' | 'busy' | { throws: unknown };
  makeThrows?: boolean;
  /** 注入的测试账号 uid（默认 A，和假数据库对上）；传 UID_PLACEHOLDER 测占位值 */
  testUid?: string;
}

export function setup(s: Setup = {}) {
  const db = fakeDb(s.db);
  let wall = s.wall ?? T0;
  const made: number[] = [];
  const guarded: number[] = [];
  const g = s.guard ?? 'ok';
  const guard: Guard = async (fn) => {
    guarded.push(1);
    if (g === 'busy') return { got: false };
    if (typeof g === 'object') throw g.throws;
    return { got: true, value: await fn() };
  };
  const deps: HandlerDeps = {
    supabaseUrl: 'supabaseUrl' in s ? s.supabaseUrl : PREVIEW_URL,
    region: 'ap-northeast-2',
    makeProbe: () => {
      made.push(1);
      if (s.makeThrows) throw new Error(`FN_AI_DB_URL 未设置 ${FAKE_URL}`);
      return db.deps(s.probe);
    },
    guard,
    limiter: { last: null },
    now: () => wall,
    instance: { id: 'abc123abc123', bootAt: T0 - 5_000 },
    testUid: s.testUid ?? A,
  };
  return { deps, db, made, guarded, advance: (ms: number) => (wall += ms) };
}

export const post = (body: unknown = { action: 'run' }, init: RequestInit = {}) =>
  new Request('https://x/functions/v1/db-probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });

export type Body = ProbeReport & { region: string | null; instance: { id: string; age_s: number }; guard?: { ok: boolean; code: string } };
export const run = async (s: ReturnType<typeof setup>, body?: unknown) => {
  const r = await handle(post(body), s.deps);
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) as Body, headers: r.headers };
};

/** 响应里不能出现的东西：密码、主机名、整条连接串、报错原文里常见的词 */
export const NO_LEAK = [SECRET_PW, POOL_HOST, 'postgresql://', 'pooler.supabase.com', 'sslmode=require', 'password authentication failed'];
export const expectNoLeak = (text: string) => {
  for (const s of NO_LEAK) expect(text, s).not.toContain(s);
};

// 有用例用了 vi.useFakeTimers（P6 超总预算）：每条用例后一律换回真计时器，免得假计时器带到后面的用例
afterEach(() => {
  vi.useRealTimers();
});
