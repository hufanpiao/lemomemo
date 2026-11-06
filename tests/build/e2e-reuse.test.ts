// e2e 默认不复用旧服务（FA-6 执行说明“四之一、已知坑”，主持人 11-04 定）：
// • tools/e2e/reuse-servers.mjs：CI 以外设了 LEMO_E2E_REUSE=1 才复用，别的写法、CI 里一律不复用；
// • 两个无后端配置真加载出来的 reuseExistingServer：默认 false，LEMO_E2E_REUSE=1 才 true，改了假后端端口照旧 false；
// • run-watchdog 起跑前查 --check-ports：有一个被占着就不拉起命令、退出码 125、说清是哪个端口；设了 LEMO_E2E_REUSE=1 照常拉起
// • 命令行入口真跑一次（首屏判断复审 新 L1：入口把 checkPorts 传丢了，上面直接调 runWatchdog 的用例拦不住）
// 会起 node 子进程（拉起命令那一条），登记在 vitest.config.ts 的 SLOW_NODE_TESTS
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaywrightTestConfig } from '@playwright/test';
import { PORT_BUSY_EXIT_CODE, busyPorts, runWatchdog } from '../../tools/e2e/run-watchdog.mjs';
import { REUSE_ENV, reuseServers } from '../../tools/e2e/reuse-servers.mjs';

const SLOW = { timeout: 30_000 };

function sink(): { stream: Writable; text: () => string } {
  let buf = '';
  const stream = new Writable({ write: (chunk: Buffer, _enc, cb) => void ((buf += chunk.toString()), cb()) });
  return { stream, text: () => buf };
}

async function listen(): Promise<{ srv: Server; port: number }> {
  const srv = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { srv, port: (srv.address() as { port: number }).port };
}

const close = (srv: Server) => new Promise((r) => srv.close(r));

describe('要不要复用已经在跑的服务（reuseServers）', () => {
  it('只有 CI 以外、LEMO_E2E_REUSE 恰好是 1 才复用', () => {
    expect(REUSE_ENV).toBe('LEMO_E2E_REUSE');
    expect(reuseServers({})).toBe(false);
    expect(reuseServers({ LEMO_E2E_REUSE: '1' })).toBe(true);
    for (const v of ['', '0', 'true', 'yes', ' 1']) expect(reuseServers({ LEMO_E2E_REUSE: v }), JSON.stringify(v)).toBe(false);
    expect(reuseServers({ LEMO_E2E_REUSE: '1', CI: 'true' })).toBe(false);
  });
});

describe('两个无后端配置真加载出来的 reuseExistingServer', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    vi.resetModules();
  });
  async function reuseOf(file: string, env: Record<string, string | undefined>): Promise<boolean[]> {
    for (const k of ['CI', 'LEMO_E2E_REUSE', 'LEMO_E2E_FAKE_S3_PORT', 'LEMO_E2E_FAKE_SB_PORT']) delete process.env[k];
    Object.assign(process.env, env);
    vi.resetModules();
    const cfg = ((await import(/* @vite-ignore */ `../../${file}?t=${Date.now()}`)) as { default: PlaywrightTestConfig }).default;
    const ws = Array.isArray(cfg.webServer) ? cfg.webServer : cfg.webServer ? [cfg.webServer] : [];
    expect(ws.length).toBeGreaterThan(0);
    return ws.map((w) => Boolean(w.reuseExistingServer));
  }
  for (const file of ['playwright.config.ts', 'playwright.fastread.config.ts']) {
    it(`${file}：默认不复用；LEMO_E2E_REUSE=1 才复用；CI、改了假后端端口照旧不复用`, async () => {
      expect(new Set(await reuseOf(file, {}))).toEqual(new Set([false]));
      expect(new Set(await reuseOf(file, { LEMO_E2E_REUSE: '1' }))).toEqual(new Set([true]));
      expect(new Set(await reuseOf(file, { LEMO_E2E_REUSE: '1', CI: 'true' }))).toEqual(new Set([false]));
      expect(new Set(await reuseOf(file, { LEMO_E2E_REUSE: '1', LEMO_E2E_FAKE_S3_PORT: '9195' }))).toEqual(new Set([false]));
    });
  }
});

describe('run-watchdog 起跑前查端口', () => {
  it('busyPorts：只列出有进程在听的', SLOW, async () => {
    const { srv, port } = await listen();
    try {
      expect(await busyPorts([1, port])).toEqual([port]);
      expect(await busyPorts([])).toEqual([]);
    } finally {
      await close(srv);
    }
  });

  it('有端口被占着：不拉起命令，退出码 125，说清是哪个端口和怎么复用', SLOW, async () => {
    const { srv, port } = await listen();
    try {
      const err = sink();
      const spawned = vi.fn();
      const code = await runWatchdog({ command: ['node', '-e', 'process.exit(0)'], silenceMs: 60_000, checkPorts: [1, port], env: {}, err: err.stream, onSpawn: spawned });
      expect(code).toBe(PORT_BUSY_EXIT_CODE);
      expect(PORT_BUSY_EXIT_CODE).toBe(125);
      expect(spawned).not.toHaveBeenCalled();
      expect(err.text()).toContain(`端口 ${port} 已经有进程在监听，不拉起命令`);
      expect(err.text()).not.toContain('端口 1 ');
      expect(err.text()).toContain('LEMO_E2E_REUSE=1');
      // CI 里照样先查（CI 本来就不复用）
      expect(await runWatchdog({ command: ['node', '-e', 'process.exit(0)'], silenceMs: 60_000, checkPorts: [port], env: { CI: 'true' }, ci: true, err: sink().stream })).toBe(125);
    } finally {
      await close(srv);
    }
  });

  it('设了 LEMO_E2E_REUSE=1：端口占着也照常拉起，退出码原样带出；端口都空着时照常拉起', SLOW, async () => {
    const { srv, port } = await listen();
    try {
      const spawned = vi.fn();
      expect(await runWatchdog({ command: ['node', '-e', 'process.exit(7)'], silenceMs: 60_000, checkPorts: [port], env: { LEMO_E2E_REUSE: '1' }, out: sink().stream, err: sink().stream, onSpawn: spawned })).toBe(7);
      expect(spawned).toHaveBeenCalledTimes(1);
    } finally {
      await close(srv);
    }
    expect(await runWatchdog({ command: ['node', '-e', 'process.exit(6)'], silenceMs: 60_000, checkPorts: [port], env: {}, out: sink().stream, err: sink().stream })).toBe(6);
  });
});

describe('run-watchdog 命令行入口（首屏判断复审 新 L1）', () => {
  it('node tools/e2e/run-watchdog.mjs --check-ports <占着的端口> -- …：退出码 125，命令没被拉起', SLOW, async () => {
    const { srv, port } = await listen();
    const dir = mkdtempSync(join(tmpdir(), 'lemo-watchdog-'));
    const marker = join(dir, 'spawned');
    try {
      const env = { ...process.env };
      delete env['CI'];
      delete env[REUSE_ENV];
      const code = await new Promise<number | null>((ok) => {
        const p = execFile(
          process.execPath,
          [join(import.meta.dirname, '..', '..', 'tools', 'e2e', 'run-watchdog.mjs'), '--check-ports', String(port), '--', 'node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
          { env },
          () => undefined,
        );
        p.on('exit', (c) => ok(c));
      });
      expect(code).toBe(PORT_BUSY_EXIT_CODE);
      expect(existsSync(marker), '端口占着还拉起了命令').toBe(false);
    } finally {
      await close(srv);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
