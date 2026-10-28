// version-gate 的单元测试（架构 0.27 第 1 点；TC-B0-46～51 的函数层部分，经 /sb/ 的整条链路见 sb-proxy.test.ts）
import { describe, expect, it, vi } from 'vitest';
import {
  EXEMPT_FUNCTIONS,
  EXEMPT_RULES,
  compareTriple,
  createVersionGate,
  needsVersionCheck,
  parseClientVersion,
  parseStrict,
  upgradeRequiredResponse,
} from '../../functions/sb/version-gate.ts';

function headers(v?: string): Headers {
  const h = new Headers();
  if (v !== undefined) h.set('X-App-Version', v);
  return h;
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('needsVersionCheck：哪些请求要查', () => {
  it.each([
    ['POST', '/rest/v1/todos'],
    ['PATCH', '/rest/v1/todos'],
    ['PUT', '/rest/v1/todos'],
    ['DELETE', '/rest/v1/todos'],
    ['POST', '/rest/v1/rpc/apply_patch'],
    ['POST', '/storage/v1/object/images/a/b.webp'],
    ['PUT', '/storage/v1/object/images/a/b.webp'],
    ['DELETE', '/storage/v1/object/images'],
    ['POST', '/storage/v1/object/upload/sign/images/a.webp'],
    ['POST', '/storage/v1/object/move'],
    ['POST', '/functions/v1/ai-parse'],
    ['GET', '/functions/v1/anything'],
    // 0.32：存储签名、列文件不再免查（客户端不访问 Supabase Storage，/sb 回 404）
    ['POST', '/storage/v1/object/sign/images'],
    ['POST', '/storage/v1/object/list/images'],
    // 0.32：/files 的上传要查（14.2 第 11 点、TC-B0-51）
    ['PUT', '/files/v1/o/images/a/b/c.webp'],
    ['PUT', '/files/v1/o/files/a/b/c.pdf'],
  ])('%s %s → 查', (m, p) => {
    expect(needsVersionCheck(m, p)).toBe(true);
  });

  it.each([
    ['GET', '/rest/v1/todos'],
    ['HEAD', '/rest/v1/todos'],
    ['GET', '/rest/v1/rpc/my_ai_usage'],
    ['GET', '/storage/v1/object/authenticated/images/a.webp'],
    ['POST', '/auth/v1/otp'],
    ['POST', '/auth/v1/token'],
    ['POST', '/auth/v1/logout'],
    ['DELETE', '/auth/v1/factors/x'],
    ['GET', '/realtime/v1/websocket'],
    // 0.32：/files 的签名和取对象只是读
    ['POST', '/files/v1/sign'],
    ['GET', '/files/v1/o/images/a/b/c.webp'],
    ['OPTIONS', '/files/v1/o/images/a/b/c.webp'],
    ['OPTIONS', '/rest/v1/todos'],
    ['OPTIONS', '/functions/v1/ai-parse'],
  ])('%s %s → 不查', (m, p) => {
    expect(needsVersionCheck(m, p)).toBe(false);
  });

  it('0.32：免查名单里没有 /storage/v1/ 的规则', () => {
    expect(EXEMPT_RULES.filter((r) => r.path.startsWith('/storage/'))).toEqual([]);
    expect(needsVersionCheck('DELETE', '/storage/v1/object/sign/images/a.webp')).toBe(true);
  });

  it('B0 的免查函数名单是空的（各批随函数加）', () => {
    expect(EXEMPT_FUNCTIONS).toEqual([]);
  });
});

describe('版本号', () => {
  it('去掉 -preview 后缀只比三段', () => {
    expect(parseClientVersion('4.1.0-preview.3')).toEqual([4, 1, 0]);
    expect(parseClientVersion('4.0.9-preview.9')).toEqual([4, 0, 9]);
    expect(parseClientVersion('4.0.0+build.7')).toEqual([4, 0, 0]);
    expect(parseClientVersion(' 4.0.1 ')).toEqual([4, 0, 1]);
  });

  it('格式不对返回 null', () => {
    for (const v of ['', '4.1', '4.1.0.1', 'v4.1.0', 'abc', '4.x.0', '-4.0.0', '1234567.0.0']) {
      expect(parseClientVersion(v)).toBeNull();
    }
    expect(parseClientVersion(null)).toBeNull();
  });

  it('配置值只认不带后缀的三段', () => {
    expect(parseStrict('4.0.0')).toEqual([4, 0, 0]);
    expect(parseStrict('4.1')).toBeNull();
    expect(parseStrict('4.1.0-preview.1')).toBeNull();
  });

  it('按数字比，不按字符串比', () => {
    expect(compareTriple([4, 10, 0], [4, 9, 9])).toBe(1);
    expect(compareTriple([4, 0, 0], [4, 0, 0])).toBe(0);
    expect(compareTriple([3, 9, 9], [4, 0, 0])).toBe(-1);
  });
});

describe('createVersionGate', () => {
  it('TC-B0-46：没带版本头 → block，min 来自配置', async () => {
    const gate = createVersionGate({ loadMin: async () => '4.0.0' });
    expect(await gate.check('PATCH', '/rest/v1/todos', headers())).toEqual({ action: 'block', min: '4.0.0' });
  });

  it('TC-B0-47：3.9.9 拦，4.0.0、4.0.1 放', async () => {
    const gate = createVersionGate({ loadMin: async () => '4.0.0' });
    expect((await gate.check('PATCH', '/rest/v1/todos', headers('3.9.9'))).action).toBe('block');
    expect((await gate.check('PATCH', '/rest/v1/todos', headers('4.0.0'))).action).toBe('pass');
    expect((await gate.check('PATCH', '/rest/v1/todos', headers('4.0.1'))).action).toBe('pass');
  });

  it('TC-B0-48：min=4.1.0 时 4.1.0-preview.3 放、4.0.9-preview.9 拦', async () => {
    const gate = createVersionGate({ loadMin: async () => '4.1.0' });
    expect((await gate.check('POST', '/rest/v1/todos', headers('4.1.0-preview.3'))).action).toBe('pass');
    expect(await gate.check('POST', '/rest/v1/todos', headers('4.0.9-preview.9'))).toEqual({ action: 'block', min: '4.1.0' });
  });

  it('格式不对的版本头当没带', async () => {
    const gate = createVersionGate({ loadMin: async () => '4.0.0' });
    expect((await gate.check('POST', '/rest/v1/todos', headers('latest'))).action).toBe('block');
  });

  it('TC-B0-49：读配置超时就放行，失败结果缓存 10 秒，日志只有错误码', async () => {
    const c = clock();
    const log = vi.fn();
    const loadMin = vi.fn((signal: AbortSignal) => new Promise<unknown>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const gate = createVersionGate({ loadMin, now: c.now, log, timeoutMs: 20 });
    expect((await gate.check('POST', '/rest/v1/todos', headers())).action).toBe('pass');
    expect(log).toHaveBeenCalledWith('gate_config_timeout');
    c.advance(9_999);
    expect((await gate.check('POST', '/rest/v1/todos', headers())).action).toBe('pass');
    expect(loadMin).toHaveBeenCalledTimes(1); // 10 秒内不再读
    c.advance(2);
    await gate.check('POST', '/rest/v1/todos', headers());
    expect(loadMin).toHaveBeenCalledTimes(2);
    for (const call of log.mock.calls) expect(String(call[0])).not.toMatch(/https?:|\//);
  });

  it('TC-B0-49：返回坏格式（4.1、空、数字）也放行并缓存 10 秒', async () => {
    for (const bad of ['4.1', '', 4, null, '4.1.0-preview.1']) {
      const c = clock();
      const log = vi.fn();
      const loadMin = vi.fn(async () => bad);
      const gate = createVersionGate({ loadMin, now: c.now, log });
      expect((await gate.check('POST', '/rest/v1/todos', headers())).action).toBe('pass');
      expect(log).toHaveBeenCalledWith('gate_config_bad');
      c.advance(5_000);
      await gate.check('POST', '/rest/v1/todos', headers());
      expect(loadMin).toHaveBeenCalledTimes(1);
    }
  });

  it('读配置抛错也放行', async () => {
    const log = vi.fn();
    const gate = createVersionGate({ loadMin: async () => Promise.reject(new Error('boom')), log });
    expect((await gate.check('POST', '/rest/v1/todos', headers())).action).toBe('pass');
    expect(log).toHaveBeenCalledWith('gate_config_error');
  });

  it('TC-B0-50：成功的结果缓存 60 秒，并发请求只读一次', async () => {
    const c = clock();
    const loadMin = vi.fn(async () => '4.0.0');
    const gate = createVersionGate({ loadMin, now: c.now });
    await Promise.all([1, 2, 3].map(() => gate.check('POST', '/rest/v1/todos', headers('4.0.0'))));
    c.advance(59_999);
    await gate.check('POST', '/rest/v1/todos', headers('4.0.0'));
    expect(loadMin).toHaveBeenCalledTimes(1);
    c.advance(2);
    await gate.check('POST', '/rest/v1/todos', headers('4.0.0'));
    expect(loadMin).toHaveBeenCalledTimes(2);
  });

  it('TC-B0-51：免查的请求连配置都不读', async () => {
    const loadMin = vi.fn(async () => '9.9.9');
    const gate = createVersionGate({ loadMin });
    expect((await gate.check('POST', '/auth/v1/otp', headers())).action).toBe('pass');
    expect((await gate.check('POST', '/files/v1/sign', headers())).action).toBe('pass');
    expect((await gate.check('GET', '/files/v1/o/images/a/b/c.webp', headers())).action).toBe('pass');
    expect(loadMin).not.toHaveBeenCalled();
  });
});

describe('upgradeRequiredResponse', () => {
  it('426、响应体、安全头、CORS 接口', async () => {
    const r = upgradeRequiredResponse('4.1.0', (h) => h.set('Access-Control-Allow-Origin', 'http://tauri.localhost'));
    expect(r.status).toBe(426);
    expect(await r.json()).toEqual({ code: 'upgrade_required', min: '4.1.0' });
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('http://tauri.localhost');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });
});
