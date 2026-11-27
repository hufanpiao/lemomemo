// E2E 假后端的固定假值（tests/e2e/fake-backends.ts、playwright.config.ts、playwright.real.config.ts 共用）。
// 一看就是假的，只给本机用，不是密钥；真的 R2 令牌、FILES_URL_SECRET 只在预览、正式（环境清单第四节）。
//
// 假后端端口（接手清单 E2E-parallel，需求记录 R-267 D1）：无后端组默认 9199（S3 替身）、9198（假 Supabase），
// 真后端组默认 9197、9196，两组可以同时起、互不抢端口。两组都可以用 LEMO_E2E_FAKE_S3_PORT、LEMO_E2E_FAKE_SB_PORT 覆盖，
// 只认纯十进制、9190～9199、两个端口不同；不合格直接抛错（fakePorts）。
// 这几个端口不进 tests/e2e/real-backend.ts 的 ALLOWED_PORTS：真后端组的护栏照旧只放 55321、55324、8789。
export const FAKE_S3_PORT = 9199;
export const FAKE_SUPABASE_PORT = 9198;
export const FAKE_S3_KEY_ID = 'FAKEKEYIDE2EONLY';
export const FAKE_S3_SECRET = 'fake-s3-secret-for-e2e-only';
export const FAKE_ANON_KEY = 'fake-anon-key';
export const FAKE_FILES_URL_SECRET = 'fake-files-url-secret-for-e2e-only-000000';
/** /sb 转发层写给上游的 x-proxy-secret；没有它 functions/sb/[[path]].ts 一律回 500 proxy_misconfigured */
export const FAKE_PROXY_SECRET = 'fake-proxy-secret-for-e2e-only';

/** 一组假后端的两个端口 */
export interface FakePorts {
  readonly s3: number;
  readonly supabase: number;
}

/** 无后端组（playwright.config.ts）的默认端口 */
export const DEFAULT_FAKE_PORTS: FakePorts = { s3: FAKE_S3_PORT, supabase: FAKE_SUPABASE_PORT };
/** 真后端组（playwright.real.config.ts）的默认端口：和无后端组错开，两组能同时跑（R-267 D1） */
export const REAL_GROUP_FAKE_PORTS: FakePorts = { s3: 9197, supabase: 9196 };
/** 假后端端口只许落在这一段（含两端） */
export const FAKE_PORT_RANGE: readonly [number, number] = [9190, 9199];
/** 覆盖端口用的环境变量名 */
export const FAKE_PORT_ENV = { s3: 'LEMO_E2E_FAKE_S3_PORT', supabase: 'LEMO_E2E_FAKE_SB_PORT' } as const;

function portFrom(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  // 只认纯十进制（"9198 "、"+9198"、"0x23ee"、"9_198" 一律拒）；消息只带变量名，不回显原值
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} 必须是纯十进制端口号`);
  const port = Number(raw);
  const [lo, hi] = FAKE_PORT_RANGE;
  if (port < lo || port > hi) throw new Error(`${name} 的端口 ${port} 不在 ${lo}～${hi} 之间`);
  return port;
}

/**
 * 读 LEMO_E2E_FAKE_S3_PORT、LEMO_E2E_FAKE_SB_PORT；没设（或空字符串）就用 defaults。
 * 不合格（非纯十进制、不在 9190～9199、两个端口相同）抛错，消息只带变量名和端口
 */
export function fakePorts(env: Readonly<Record<string, string | undefined>>, defaults: FakePorts = DEFAULT_FAKE_PORTS): FakePorts {
  const s3 = portFrom(env, FAKE_PORT_ENV.s3, defaults.s3);
  const supabase = portFrom(env, FAKE_PORT_ENV.supabase, defaults.supabase);
  if (s3 === supabase) throw new Error(`${FAKE_PORT_ENV.s3} 和 ${FAKE_PORT_ENV.supabase} 不能是同一个端口 ${s3}`);
  return { s3, supabase };
}

/** wrangler pages dev 的 --binding（/files 和 /sb 函数读的环境变量），指向本机假后端；R2_BUCKET_PREFIX 不设（当空字符串） */
export function e2eBindings(ports: FakePorts): Record<string, string> {
  return {
    SUPABASE_UPSTREAM: `http://127.0.0.1:${ports.supabase}`,
    SUPABASE_ANON_KEY: FAKE_ANON_KEY,
    R2_ENDPOINT: `http://127.0.0.1:${ports.s3}`,
    R2_FILES_ACCESS_KEY_ID: FAKE_S3_KEY_ID,
    R2_FILES_SECRET_ACCESS_KEY: FAKE_S3_SECRET,
    FILES_URL_SECRET: FAKE_FILES_URL_SECRET,
    PROXY_SECRET: FAKE_PROXY_SECRET,
  };
}

/** 默认端口（9199、9198）下的 binding */
export const E2E_BINDINGS: Record<string, string> = e2eBindings(DEFAULT_FAKE_PORTS);
