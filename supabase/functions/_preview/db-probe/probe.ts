// db-probe 的步骤（预览专用、一次性；B0 实测清单 P6 函数侧那几项，说明和下线步骤见 docs/09-路线图/B0-P6数据库探测函数.md）。
// 只 import 类型，不碰 Deno、不碰 postgres：数据库操作全部由 index.ts 注入（_shared/db.ts 的 withUser / withScan，和同样参数自开的连接），
// 所以 Vitest 能直接测。
//
// 报告里只有：通过 / 不通过（布尔）、行数、错误码、耗时。连接串、密码、主机名、用户名原文、报错原文一律不进报告。
// 错误码只取 SQLSTATE（5 位）或 postgres.js / Node 的大写错误码；都没有时按报错文字归成几类固定的词（errCode），原文丢掉。

/** 预览项目 ref（只认这一个项目，handler.ts 用它做环境判断；也用来核对用户名 fn_ai.<ref>） */
export const PREVIEW_REF = 'yoeqwhygehbaftkppati';
/**
 * 测试账号 A（预览项目唯一的用户 hufanp+lemotest@gmail.com）的 uid。安全审查必改 2：写死在这里，不由调用方传。
 * 10-29 主持人在预览控制台 Authentication › Users 核对。随 db-probe 一起删。
 */
export const TEST_UID = '7aa8c4cb-11ba-4e9e-aa6f-72196dfe3f8b';
/** 占位值：TEST_UID 是它时 handler 回 500 misconfigured，不连库 */
export const UID_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';
/** “同一连接的下一个事务”测几轮（每轮两个事务） */
export const ROUNDS = 3;
/** 不加密连接“被拒”只认这几个码（白名单）：SQLSTATE 28000、postgres.js 的连接被关、对端重置、TLS / 网络类 */
export const PLAIN_REJECTED: ReadonlySet<string> = new Set(['28000', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'ECONNRESET', 'tls_other', 'network']);
/** 整次运行的总预算：超了以后剩下的步骤不做，报 skipped_deadline；正在做的那一步报 deadline */
export const TOTAL_BUDGET_MS = 30_000;

/** 一条查询：和 postgres.js 的 tx`…${参数}` 一样的写法，返回行数组 */
export type Query = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<readonly Record<string, unknown>[]>;

/** 自开连接的 TLS 设置：require = 和 _shared/db.ts 一样；ca = 用 Supabase 根证书校验；disable = 不加密（只在 plaintext 打开时用，预期被拒） */
export type Tls = 'require' | 'ca' | 'disable';

/** 自开的一条连接（postgres.js，max: 1，其余参数和 _shared/db.ts 一样）；tx 是 begin … commit，出错 rollback */
export interface Session {
  tx<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** 连接串里能公开说的几件事（index.ts 解析，原文不出 index.ts） */
export interface UrlFacts {
  present: boolean;
  /** 用户名是 fn_ai.<PREVIEW_REF> */
  userIsFnAiRef: boolean;
  /** 主机名以 .pooler.supabase.com 结尾（Supavisor） */
  hostIsPooler: boolean;
  /** 端口是 6543（事务模式） */
  port6543: boolean;
  /** 查询参数 sslmode=require */
  sslmodeRequire: boolean;
  /** 带了密码（不说是什么） */
  hasPassword: boolean;
}

/** 解析 FN_AI_DB_URL：只给出 UrlFacts 那几个布尔值和主机名（主机名只给 index.ts 当 servername 用，不进报告） */
export function urlFacts(raw: string | undefined): { facts: UrlFacts; host: string | null } {
  const none: UrlFacts = { present: false, userIsFnAiRef: false, hostIsPooler: false, port6543: false, sslmodeRequire: false, hasPassword: false };
  if (!raw) return { facts: none, host: null };
  try {
    const u = new URL(raw);
    return {
      facts: {
        present: true,
        userIsFnAiRef: decodeURIComponent(u.username) === `fn_ai.${PREVIEW_REF}`,
        hostIsPooler: u.hostname.endsWith('.pooler.supabase.com'),
        port6543: u.port === '6543',
        sslmodeRequire: u.searchParams.get('sslmode') === 'require',
        hasPassword: u.password !== '',
      },
      host: u.hostname,
    };
  } catch {
    return { facts: { ...none, present: true }, host: null };
  }
}

/**
 * 自开连接用的连接串（安全审查必改 1）：require、ca 用原串；disable（不加密）一律把密码换成每次随机的 32 字节十六进制假密码——
 * postgres.js 里 ssl: false 会盖掉 sslmode，服务器一要求明文认证（cleartext / md5），真密码就直接发出去了。
 * 换成假密码后，就算服务器接受了不加密连接，发出去的也只是假密码，认证必然失败（28P01），按“没被拒”判不通过。
 */
export function connUrl(raw: string, tls: Tls, randomHex: (bytes: number) => string): string {
  if (tls !== 'disable') return raw;
  const u = new URL(raw);
  u.password = randomHex(32);
  return u.toString();
}

const PEM = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/;

/** 证书的 SHA-256 指纹（DER），和 PowerShell 里 X509Certificate2.GetCertHashString('SHA256') 对得上（大小写不同） */
export async function caFingerprint(pem: string): Promise<string | null> {
  const t = pem.trim();
  if (!PEM.test(t)) return null;
  const b64 = t.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export interface ProbeDeps {
  url: UrlFacts;
  /** LEMO_PROBE 这个 secret 在不在（实测清单 P6 ⑦：控制台加、删一次，看函数下次启动读到的变化；值不读） */
  lemoProbePresent: boolean;
  /** _shared/db.ts 的 withUser('fn_ai', uid, …) */
  withUser<T>(uid: string, fn: (q: Query) => Promise<T>): Promise<T>;
  /** _shared/db.ts 的 withScan('fn_ai', …) */
  withScan<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  /** 自开一条连接（同 db.ts 的参数，只换 ssl） */
  open(tls: Tls): Session;
  /** 嵌进来的 Supabase 根证书的 SHA-256 指纹（DER，十六进制小写）；没放证书时为 null，tls_ca 报 skipped */
  caFingerprint: string | null;
  clock: () => number;
}

export interface StepBase {
  ok: boolean;
  code?: string;
  ms: number;
}

/** 报错只留错误码，原文丢掉（原文里可能有主机名、用户名） */
export function errCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (/^[0-9A-Z]{5}$/.test(code)) return code; // SQLSTATE，如 28P01、42501、3D000
    if (/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code; // postgres.js / Node：CONNECT_TIMEOUT、ECONNREFUSED、UNABLE_TO_VERIFY_LEAF_SIGNATURE…
  }
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (/deadline/.test(msg)) return 'deadline';
  if (/UnknownIssuer|unknown issuer|self.?signed|unable to (get|verify)|certificate verify|CERT_/i.test(msg)) return 'tls_cert_untrusted';
  if (/NotValidForName|hostname|altname|subject name/i.test(msg)) return 'tls_name_mismatch';
  if (/expired/i.test(msg)) return 'tls_cert_expired';
  if (/\b(ssl|tls)\b/i.test(msg)) return 'tls_other';
  if (/timed? ?out/i.test(msg)) return 'timeout';
  if (/password|authentication|SASL|SCRAM/i.test(msg)) return 'auth_failed';
  if (/refused|reset|closed|unreachable|dns|lookup/i.test(msg)) return 'network';
  return 'other';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

interface Budget {
  left(): number;
}

/** 跑一步：超过剩余预算报 deadline（底下的连接由 onTimeout 关掉）；预算已经用完时不跑，报 skipped_deadline */
async function step<R extends object>(
  b: Budget,
  clock: () => number,
  run: () => Promise<R>,
  onTimeout?: () => void,
): Promise<StepBase & Partial<R>> {
  const left = b.left();
  if (left <= 0) return { ok: false, code: 'skipped_deadline', ms: 0 } as StepBase & Partial<R>;
  const t0 = clock();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      run(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          onTimeout?.();
          rej(new Error('deadline'));
        }, left);
      }),
    ]);
    return { ok: true, ms: Math.round(clock() - t0), ...r };
  } catch (e) {
    return { ok: false, code: errCode(e), ms: Math.round(clock() - t0) } as StepBase & Partial<R>;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 自开连接的事务开头：和 _shared/db.ts 的 run() 一样先 set local statement_timeout */
async function txPrelude(q: Query): Promise<void> {
  await q`select set_config('statement_timeout', '4min', true)`;
}

async function withSession<R>(deps: ProbeDeps, tls: Tls, fn: (s: Session) => Promise<R>, hold: { s?: Session }): Promise<R> {
  const s = deps.open(tls);
  hold.s = s;
  try {
    return await fn(s);
  } finally {
    await s.end().catch(() => undefined);
  }
}

export interface ProbeOptions {
  uid: string;
  plaintext: boolean;
}

export async function runProbe(deps: ProbeDeps, opt: ProbeOptions) {
  const { clock } = deps;
  const t0 = clock();
  const budget: Budget = { left: () => TOTAL_BUDGET_MS - (clock() - t0) };
  const uid = opt.uid;

  const config = {
    url_present: deps.url.present,
    user_is_fn_ai_ref: deps.url.userIsFnAiRef,
    host_is_pooler: deps.url.hostIsPooler,
    port_6543: deps.url.port6543,
    sslmode_require: deps.url.sslmodeRequire,
    has_password: deps.url.hasPassword,
    lemo_probe_present: deps.lemoProbePresent,
  };

  // ① withUser('fn_ai', A, …)：经 _shared/db.ts（ssl: 'require' + 连接串 sslmode=require），登录用户名 fn_ai.<ref>（P6 ⑥、⑧ 前一半）
  const userRead = await step(budget, clock, () =>
    deps.withUser(uid, async (q) => {
      const [r] = await q`select current_user::text as u,
          coalesce(current_setting('app.uid', true), '') = ${uid} as uid_set,
          (select count(id) from public.notes)::int as n,
          (select count(id) from public.notes where user_id <> ${uid}::uuid)::int as other`;
      return {
        current_user_ok: r?.u === 'fn_ai',
        uid_set: r?.uid_set === true,
        notes: num(r?.n),
        other_users_notes: num(r?.other),
      };
    }),
  );

  // ② 同一个函数里 withScan 读 private.scan_embed_queue（不设 app.uid：基表一行都不放行，只能读扫描视图）
  const scanRead = await step(budget, clock, () =>
    deps.withScan(async (q) => {
      const [r] = await q`select current_user::text as u,
          coalesce(current_setting('app.uid', true), '') = '' as uid_empty,
          (select count(*) from private.scan_embed_queue)::int as q,
          (select count(distinct user_id) from private.scan_embed_queue)::int as qu,
          (select count(id) from public.notes)::int as n`;
      return {
        current_user_ok: r?.u === 'fn_ai',
        uid_empty: r?.uid_empty === true,
        queue_rows: num(r?.q),
        queue_users: num(r?.qu),
        notes: num(r?.n),
      };
    }),
  );

  // ③ 同一连接的下一个事务：自开一条和 db.ts 同参数的连接（max: 1，prepare: false），每轮先在一个事务里设 app.uid 读 A 的 notes，
  //    提交后在下一个事务里读 current_setting('app.uid', true) 和 notes：应为空、0 行（事务模式的 Supavisor 下 set_config(…, true) 不串）
  const nextHold: { s?: Session } = {};
  const nextTx = await step(
    budget,
    clock,
    () =>
      withSession(deps, 'require', async (s) => {
        const rounds: { notes_in: number | null; uid_after_empty: boolean; notes_after: number | null }[] = [];
        for (let i = 0; i < ROUNDS; i++) {
          const nIn = await s.tx(async (q) => {
            await txPrelude(q);
            await q`select set_config('app.uid', ${uid}, true)`;
            const [r] = await q`select (select count(id) from public.notes)::int as n`;
            return num(r?.n);
          });
          const after = await s.tx(async (q) => {
            await txPrelude(q);
            const [r] = await q`select coalesce(current_setting('app.uid', true), '') = '' as uid_empty,
                (select count(id) from public.notes)::int as n`;
            return { uid_after_empty: r?.uid_empty === true, notes_after: num(r?.n) };
          });
          rounds.push({ notes_in: nIn, ...after });
        }
        return { rounds };
      }, nextHold),
    () => void nextHold.s?.end().catch(() => undefined),
  );

  // ④ TLS 第二种：ssl: { ca: Supabase 根证书, rejectUnauthorized: true, servername: 连接池主机名 }（P6 ⑧ 后一半）
  const caHold: { s?: Session } = {};
  const tlsCa = deps.caFingerprint === null
    ? { ok: false, code: 'skipped_no_ca', ms: 0 }
    : {
        ...(await step(
          budget,
          clock,
          () =>
            withSession(deps, 'ca', async (s) => {
              const ok = await s.tx(async (q) => {
                const [r] = await q`select current_user::text as u`;
                return r?.u === 'fn_ai';
              });
              return { current_user_ok: ok };
            }, caHold),
          () => void caHold.s?.end().catch(() => undefined),
        )),
        ca_fingerprint_sha256: deps.caFingerprint,
      };

  // ⑤ 可选（P6 ⑪，请求里带 "plaintext": true 才做）：不加密、用假密码连一次（connUrl），预期在认证之前就被拒。判读（安全审查必改 1）：
  //    白名单判读（复审必改）：
  //    连上了，或报 28P01 / auth_failed（服务器已经走到认证那一步 = 接受了不加密连接）→ rejected = false，不通过；
  //    只有 PLAIN_REJECTED 里的码 → rejected = true（被拒）；
  //    其他所有码（XX000 这类通用码、other、deadline、timeout……）→ 说不清，ok = false 且 inconclusive = true，code 照实带上。
  //    Supavisor 认证失败可能回 XX000，不能当成“被拒”，否则会把 Enforce SSL 没生效误判成已生效
  const plainHold: { s?: Session } = {};
  let plaintext: { skipped: true } | (StepBase & { rejected: boolean; inconclusive: boolean });
  if (!opt.plaintext) {
    plaintext = { skipped: true };
  } else {
    const r = await step(
      budget,
      clock,
      () =>
        withSession(deps, 'disable', async (s) => {
          await s.tx(async (q) => {
            await q`select 1 as one`;
          });
          return {};
        }, plainHold),
      () => void plainHold.s?.end().catch(() => undefined),
    );
    const code = r.code ?? '';
    const reachedAuth = r.ok || code === '28P01' || code === 'auth_failed';
    const rejected = !reachedAuth && PLAIN_REJECTED.has(code);
    const inconclusive = !reachedAuth && !rejected;
    plaintext = { ok: rejected, rejected, inconclusive, ms: r.ms, ...(r.code ? { code: r.code } : {}) };
  }

  const rounds = (nextTx as { rounds?: { notes_in: number | null; uid_after_empty: boolean; notes_after: number | null }[] }).rounds ?? [];
  const u = userRead as StepBase & { current_user_ok?: boolean; uid_set?: boolean; notes?: number | null; other_users_notes?: number | null };
  const sc = scanRead as StepBase & { current_user_ok?: boolean; uid_empty?: boolean; notes?: number | null };
  const checks = {
    // P6 ⑥：fn_ai.<ref> 经 Supavisor 能登录（连接串格式对、withUser 那一步连上了、current_user 是 fn_ai）
    login_fn_ai_ref: config.user_is_fn_ai_ref && config.host_is_pooler && config.port_6543 && u.ok && u.current_user_ok === true,
    // P6 ⑧ 前一半：ssl: 'require' + sslmode=require 能连上
    tls_require: config.sslmode_require && u.ok,
    // withUser 设上了 app.uid，只看得到 A 自己的行
    with_user: u.ok && u.current_user_ok === true && u.uid_set === true && u.other_users_notes === 0,
    // withScan 不设 app.uid，基表 0 行，扫描视图读得到（行数照实报）
    with_scan: sc.ok && sc.current_user_ok === true && sc.uid_empty === true && sc.notes === 0,
    // 同一连接的下一个事务不串（每轮 app.uid 为空、notes 0 行；设了 app.uid 的那个事务读到的行数和 withUser 一样）
    next_tx_isolated: nextTx.ok && rounds.length === ROUNDS && rounds.every((r) => r.uid_after_empty && r.notes_after === 0 && r.notes_in === u.notes),
    // P6 ⑧ 后一半：证书能用 Supabase 根证书校验通过（没放证书时为 false，code 是 skipped_no_ca）
    tls_ca: tlsCa.ok,
  };
  // 总的 ok 只看 P6 的必过项；tls_ca 不过有退路（保持 'require'，另记待办），单独看 checks.tls_ca
  const ok = checks.login_fn_ai_ref && checks.tls_require && checks.with_user && checks.with_scan && checks.next_tx_isolated
    && (opt.plaintext ? (plaintext as { rejected?: boolean }).rejected === true : true);

  return {
    ok,
    total_ms: Math.round(clock() - t0),
    checks,
    config,
    user_read: userRead,
    scan_read: scanRead,
    next_tx: nextTx,
    tls_ca: tlsCa,
    plaintext,
  };
}

export type ProbeReport = Awaited<ReturnType<typeof runProbe>>;
