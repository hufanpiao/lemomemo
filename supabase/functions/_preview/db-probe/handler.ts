// db-probe 的 HTTP 一层（预览专用、一次性；说明和下线步骤见 docs/09-路线图/B0-P6数据库探测函数.md）。
// 照 r2-probe 的办法，按“任何人都能调用”设计：不靠 JWT（预览部署时 verify_jwt = false），靠下面几道：
//   ① 环境判断：SUPABASE_URL（平台自动注入）不是一字不差的 https://<预览 ref>.supabase.co（只许末尾多一个斜杠）→ 404，什么都不做（不读连接串、不连库）。
//      r2-probe 看的是 R2_BUCKET_PREFIX；这个函数不在能读 R2_* 的名单里（check_backend F3），改看平台注入的项目地址，只认预览这一个 ref；
//   ② 写死的过期时间 EXPIRES_AT：过了一律 410，不连库；
//   ③ 只接受 POST、请求体 ≤ 256 字节、只能是 {"action":"run"}，可另带 "plaintext": true / false；测试账号 A 的 uid 写死在 probe.ts 的
//      TEST_UID（安全审查必改 2），不由调用方传，带了 uid 键一律 400；TEST_UID 还是全 0 的占位值时回 500 misconfigured；
//   ④ 限频两层：同一个实例 COOLDOWN_MS 内只跑一次（429 + Retry-After）；跨实例由数据库里的事务级 advisory 锁保证同一时刻只有一次在跑
//      （拿不到回 429；锁在整次运行的那个事务里拿，提交即放，不留任何状态）；
//   ⑤ 整次运行一个总预算（probe.ts 的 TOTAL_BUDGET_MS）；
//   ⑥ 响应只有通过 / 不通过、行数、错误码、耗时；不回显连接串、密码、主机名、报错原文。
// 不打印任何东西（架构第 6 节“日志”：不打印请求头和请求体）。只 import ./probe.ts，Vitest 能直接测。
import { errCode, PREVIEW_REF, type ProbeDeps, runProbe, TEST_UID, UID_PLACEHOLDER } from './probe.ts';

/** 过了这个时间一律 410（和 r2-probe 一样取 B0 最晚签完的日子）；要延期得改代码、重新过审查 */
export const EXPIRES_AT = Date.parse('2026-11-10T15:00:00Z');
/** 同一个实例两次 run 的最短间隔 */
export const COOLDOWN_MS = 60_000;
const MAX_BODY = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 同一个实例里的限频状态（index.ts 在模块里建一份；单测每次新建） */
export interface Limiter {
  last: number | null;
}

/** 跨实例的并发锁：拿到了才跑 fn；拿不到 got = false；连库或拿锁本身失败就抛错（index.ts 用 withScan 里的 pg_try_advisory_xact_lock） */
export type Guard = <T>(fn: () => Promise<T>) => Promise<{ got: true; value: T } | { got: false }>;

export interface HandlerDeps {
  /** 平台注入的 SUPABASE_URL（环境判断用） */
  supabaseUrl: string | undefined;
  /** 平台注入的 SB_REGION（报告里写函数实际跑在哪个区域） */
  region: string | undefined;
  /** 建探测依赖（连接串由 index.ts 自己读、自己解析，这里拿不到原文）；FN_AI_DB_URL 没设时抛错，这里只回 misconfigured */
  makeProbe: () => ProbeDeps;
  guard: Guard;
  limiter: Limiter;
  now: () => number;
  /** 本实例启动时生成的随机编号和启动时间：看“函数下一次启动”有没有发生（P6 ⑦） */
  instance: { id: string; bootAt: number };
  /** 只给单测用：替换 probe.ts 的 TEST_UID（index.ts 不传，线上一律用常量） */
  testUid?: string;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

/** 安全审查必改 3：一字不差，只许去掉末尾一个斜杠；带路径、端口、用户名、查询串的一律不算 */
export function isPreview(supabaseUrl: string | undefined): boolean {
  if (!supabaseUrl) return false;
  const want = ['https', `//${PREVIEW_REF}.supabase.co`].join(':');
  return supabaseUrl === want || supabaseUrl === `${want}/`;
}

interface RunRequest {
  plaintext: boolean;
}

async function readBody(req: Request): Promise<RunRequest | null> {
  const len = req.headers.get('content-length');
  if (len !== null && !(/^\d{1,4}$/.test(len) && Number(len) <= MAX_BODY)) {
    if (req.body) await req.body.cancel().catch(() => undefined);
    return null;
  }
  if (!req.body) return null;
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  try {
    const v = JSON.parse(new TextDecoder().decode(buf)) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    const okKeys = keys.join(',') === 'action' || keys.join(',') === 'action,plaintext';
    if (!okKeys || rec.action !== 'run') return null;
    if ('plaintext' in rec && typeof rec.plaintext !== 'boolean') return null;
    return { plaintext: rec.plaintext === true };
  } catch {
    return null;
  }
}

const drop = async (req: Request) => {
  if (req.body) await req.body.cancel().catch(() => undefined);
};

export async function handle(req: Request, deps: HandlerDeps): Promise<Response> {
  // ① 不是预览项目：像没有这个函数一样
  if (!isPreview(deps.supabaseUrl)) {
    await drop(req);
    return json(404, { error: 'not_found' });
  }
  // ② 过期：不连库
  const now = deps.now();
  if (!(now < EXPIRES_AT)) {
    await drop(req);
    return json(410, { error: 'expired' });
  }
  // ③
  if (req.method !== 'POST') {
    await drop(req);
    return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
  }
  const body = await readBody(req);
  if (!body) return json(400, { error: 'bad_request' });
  // TEST_UID 还没换成测试账号 A 的真 uid：不连库、不占限频名额
  const uid = deps.testUid ?? TEST_UID;
  if (uid === UID_PLACEHOLDER || !UUID.test(uid)) return json(500, { error: 'misconfigured' });

  // ④ 本实例限频：先占名额再跑（跑失败也算一次）
  const l = deps.limiter;
  if (l.last !== null && now - l.last < COOLDOWN_MS) {
    const s = Math.max(1, Math.ceil((l.last + COOLDOWN_MS - now) / 1000));
    return json(429, { error: 'busy', retry_after_s: s }, { 'retry-after': String(s) });
  }
  l.last = now;

  let probe: ProbeDeps;
  try {
    probe = deps.makeProbe();
  } catch {
    // 不说缺的是哪一个，也不回显错误原文
    return json(500, { error: 'misconfigured' });
  }
  const meta = {
    region: deps.region ?? null,
    instance: { id: deps.instance.id, age_s: Math.max(0, Math.round((now - deps.instance.bootAt) / 1000)) },
  };

  // ④ 跨实例：同一时刻只有一次在跑。拿锁这一步本身连不上库时，照实报错误码（这就是 P6 ⑥ 不通过），别的步骤不做
  try {
    const g = await deps.guard(() => runProbe(probe, { uid, plaintext: body.plaintext }));
    if (!g.got) return json(429, { error: 'busy', retry_after_s: 30 }, { 'retry-after': '30' });
    return json(200, { ...meta, ...g.value });
  } catch (e) {
    return json(200, { ...meta, ok: false, guard: { ok: false, code: errCode(e) } });
  }
}

