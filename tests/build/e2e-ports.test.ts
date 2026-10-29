// 两组 e2e 能同时跑（接手清单 E2E-parallel，需求记录 R-267 D1）：假后端端口、wrangler 本地状态目录、调试端口两组错开；
// 真后端组合并 binding 后 SUPABASE_UPSTREAM 是真上游；919x 不进真后端组的地址白名单。
// 两个配置真 import 一次（真后端组先把四个 LEMO_E2E_* 设成假值，不跑 supabase status、不起任何进程），从 webServer 里读实际的命令和环境变量。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlaywrightTestConfig } from '@playwright/test';
import {
  DEFAULT_FAKE_PORTS, E2E_BINDINGS, FAKE_PORT_ENV, FAKE_PORT_RANGE, FAKE_S3_PORT, FAKE_SUPABASE_PORT, REAL_GROUP_FAKE_PORTS,
  e2eBindings, fakePorts,
} from '../e2e/fake-values.ts';
import { ALLOWED_PORTS, REAL_ENV, assertLocalBackendUrl } from '../e2e/real-backend.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const S3 = FAKE_PORT_ENV.s3;
const SB = FAKE_PORT_ENV.supabase;

describe('fakePorts', () => {
  it('没设、空字符串用默认值；默认就是无后端组的 9199、9198', () => {
    expect(fakePorts({})).toEqual({ s3: 9199, supabase: 9198 });
    expect(fakePorts({ [S3]: '', [SB]: '' })).toEqual(DEFAULT_FAKE_PORTS);
    expect(fakePorts({}, REAL_GROUP_FAKE_PORTS)).toEqual({ s3: 9197, supabase: 9196 });
    expect(DEFAULT_FAKE_PORTS).toEqual({ s3: FAKE_S3_PORT, supabase: FAKE_SUPABASE_PORT });
  });

  it('合法覆盖：9190～9199 之间、两端口不同；只覆盖一个时另一个用默认', () => {
    expect(fakePorts({ [S3]: '9190', [SB]: '9199' })).toEqual({ s3: 9190, supabase: 9199 });
    expect(fakePorts({ [S3]: '9195' }, REAL_GROUP_FAKE_PORTS)).toEqual({ s3: 9195, supabase: 9196 });
    expect(fakePorts({ [SB]: '9194' })).toEqual({ s3: 9199, supabase: 9194 });
  });

  it('越界拒：9189、9200，以及 54321（lemomemo）、55321（lemo-e2e API）、8789（真后端组 wrangler）', () => {
    for (const p of ['9189', '9200', '54321', '55321', '8789', '0', '65535']) {
      expect(() => fakePorts({ [S3]: p }), p).toThrow(`${S3} 的端口 ${Number(p)} 不在 9190～9199 之间`);
      expect(() => fakePorts({ [SB]: p }), p).toThrow(SB);
    }
  });

  it('非纯十进制拒，消息只带变量名、不回显原值', () => {
    for (const raw of ['9198 ', ' 9198', '+9198', '9198.0', '0x23ee', '9_198', '9e3', '９１９８', 'abc', '-9198']) {
      let msg = '';
      try {
        fakePorts({ [SB]: raw });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg, JSON.stringify(raw)).toBe(`${SB} 必须是纯十进制端口号`);
    }
  });

  it('两个端口相同拒（包括覆盖后撞上另一个的默认值）', () => {
    expect(() => fakePorts({ [S3]: '9195', [SB]: '9195' })).toThrow('不能是同一个端口 9195');
    expect(() => fakePorts({ [S3]: '9198' })).toThrow('不能是同一个端口 9198');
    expect(() => fakePorts({ [SB]: '9197' }, REAL_GROUP_FAKE_PORTS)).toThrow('不能是同一个端口 9197');
  });

  it('两组默认端口不相交，都在 FAKE_PORT_RANGE 里', () => {
    const a = Object.values(DEFAULT_FAKE_PORTS);
    const b = Object.values(REAL_GROUP_FAKE_PORTS);
    expect(a.filter((p) => b.includes(p))).toEqual([]);
    for (const p of [...a, ...b]) {
      expect(p).toBeGreaterThanOrEqual(FAKE_PORT_RANGE[0]);
      expect(p).toBeLessThanOrEqual(FAKE_PORT_RANGE[1]);
    }
  });

  it('e2eBindings 跟着端口走；E2E_BINDINGS 是默认端口的结果', () => {
    const b = e2eBindings(REAL_GROUP_FAKE_PORTS);
    expect(b['SUPABASE_UPSTREAM']).toBe('http://127.0.0.1:9196');
    expect(b['R2_ENDPOINT']).toBe('http://127.0.0.1:9197');
    expect(E2E_BINDINGS).toEqual(e2eBindings({ s3: 9199, supabase: 9198 }));
    expect(E2E_BINDINGS['R2_ENDPOINT']).toBe('http://127.0.0.1:9199');
  });
});

describe('真后端组的地址白名单不放 919x', () => {
  it('assertLocalBackendUrl 对 9190～9199 一律拒；ALLOWED_PORTS 还是 55321、55324、8789', () => {
    expect(ALLOWED_PORTS).toEqual([55321, 55324, 8789]);
    for (let p = 9190; p <= 9199; p++) {
      expect(() => assertLocalBackendUrl(`http://127.0.0.1:${p}`, 'X'), String(p)).toThrow('不在白名单里');
    }
  });
});

type WebServer = { command: string; url: string; env?: Record<string, string> };
const servers = (c: PlaywrightTestConfig) => c.webServer as WebServer[];
/** 从 wrangler 命令里取 --binding K=V */
function bindingsOf(cmd: string): Record<string, string> {
  return Object.fromEntries([...cmd.matchAll(/--binding (\w+)=(\S+)/g)].map((m) => [m[1] ?? '', m[2] ?? '']));
}
function flag(cmd: string, name: string): string | undefined {
  return new RegExp(`${name} (\\S+)`).exec(cmd)?.[1];
}

describe('两个配置真加载出来的 webServer', () => {
  let plain: PlaywrightTestConfig;
  let real: PlaywrightTestConfig;
  beforeAll(async () => {
    for (const k of [S3, SB, 'E2E_GLOBAL_TIMEOUT_MS', 'E2E_REAL_WEBKIT']) vi.stubEnv(k, '');
    // 四个都设上假值：loadBackend 不跑 supabase status；assertE2eOrigins 照查（55321、55324）
    vi.stubEnv(REAL_ENV.api, 'http://127.0.0.1:55321');
    vi.stubEnv(REAL_ENV.anonKey, 'fake-anon-for-unit-test');
    vi.stubEnv(REAL_ENV.serviceKey, 'fake-service-for-unit-test');
    vi.stubEnv(REAL_ENV.mailpit, 'http://127.0.0.1:55324');
    plain = (await import('../../playwright.config.ts')).default;
    real = (await import('../../playwright.real.config.ts')).default;
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('无后端组：假后端 9199、9198，健康检查跟着走，webServer[0] 显式传两个端口', () => {
    const [fake, web] = servers(plain);
    expect(fake?.url).toBe('http://127.0.0.1:9198/health');
    expect(fake?.env).toEqual({ [S3]: '9199', [SB]: '9198' });
    expect(bindingsOf(web?.command ?? '')).toEqual(E2E_BINDINGS);
  });

  it('真后端组：假后端 9197、9196；合并后 SUPABASE_UPSTREAM 是真上游 55321，R2 指 9197，其余同假值', () => {
    const [fake, web] = servers(real);
    expect(fake?.url).toBe('http://127.0.0.1:9196/health');
    expect(fake?.env).toEqual({ [S3]: '9197', [SB]: '9196' });
    const b = bindingsOf(web?.command ?? '');
    expect(b['SUPABASE_UPSTREAM']).toBe('http://127.0.0.1:55321');
    expect(b['SUPABASE_ANON_KEY']).toBe('fake-anon-for-unit-test');
    expect(b['R2_ENDPOINT']).toBe('http://127.0.0.1:9197');
    expect(Object.keys(b)).toEqual(Object.keys(E2E_BINDINGS));
    expect(web?.url).toBe('http://127.0.0.1:8789/app/');
  });

  it('两组的假后端端口、wrangler 端口、--persist-to、--inspector-port 都不同', () => {
    const p = servers(plain)[1]?.command ?? '';
    const r = servers(real)[1]?.command ?? '';
    expect(flag(p, '--persist-to')).toBe('.wrangler/state-e2e');
    expect(flag(r, '--persist-to')).toBe('.wrangler/state-e2e-real');
    expect(flag(p, '--inspector-port')).toBe('9230');
    expect(flag(r, '--inspector-port')).toBe('9231');
    expect(flag(p, '--port')).toBe('8788');
    expect(flag(r, '--port')).toBe('8789');
    const fp = Object.values(servers(plain)[0]?.env ?? {});
    const fr = Object.values(servers(real)[0]?.env ?? {});
    expect(fp.filter((x) => fr.includes(x))).toEqual([]);
  });

  it('LEMO_E2E_FAKE_* 覆盖时配置跟着走（源码里两组都经 fakePorts(process.env, …) 取）', () => {
    expect(read('playwright.config.ts')).toContain('fakePorts(process.env, DEFAULT_FAKE_PORTS)');
    expect(read('playwright.real.config.ts')).toContain('fakePorts(process.env, REAL_GROUP_FAKE_PORTS)');
    expect(read('tests/e2e/fake-backends.ts')).toContain('fakePorts(process.env, DEFAULT_FAKE_PORTS)');
    // 顺序不能变：真上游在后面，覆盖假后端那套
    expect(read('playwright.real.config.ts')).toContain('{ ...e2eBindings(FAKE), SUPABASE_UPSTREAM: UPSTREAM, SUPABASE_ANON_KEY: ANON }');
  });
});

describe('无后端组：覆盖了假后端端口就不复用已有服务', () => {
  async function loadPlain(env: Record<string, string>): Promise<WebServer[]> {
    vi.resetModules();
    for (const k of [S3, SB, 'CI', 'E2E_GLOBAL_TIMEOUT_MS']) vi.stubEnv(k, '');
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    try {
      return servers((await import('../../playwright.config.ts')).default);
    } finally {
      vi.unstubAllEnvs();
    }
  }
  const reuse = (ws: WebServer[]) => ws.map((w) => (w as WebServer & { reuseExistingServer?: boolean }).reuseExistingServer);

  it('没设（或空字符串）：本机照旧复用，两个服务都是 true', async () => {
    expect(reuse(await loadPlain({}))).toEqual([true, true]);
    expect(reuse(await loadPlain({ [S3]: '', [SB]: '' }))).toEqual([true, true]);
  });

  it('设了任意一个：假后端和 wrangler 一律不复用（8788 上的旧 wrangler binding 还指着 9198）', async () => {
    for (const env of [{ [S3]: '9195' }, { [SB]: '9194' }, { [S3]: '9195', [SB]: '9194' }]) {
      const ws = await loadPlain(env);
      expect(reuse(ws), JSON.stringify(env)).toEqual([false, false]);
    }
    const ws = await loadPlain({ [SB]: '9194' });
    expect(ws[0]?.url).toBe('http://127.0.0.1:9194/health');
    expect(bindingsOf(ws[1]?.command ?? '')['SUPABASE_UPSTREAM']).toBe('http://127.0.0.1:9194');
  });

  it('CI 下照旧不复用', async () => {
    expect(reuse(await loadPlain({ CI: 'true' }))).toEqual([false, false]);
  });
});
