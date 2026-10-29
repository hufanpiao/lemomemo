// e2e 不再挂死（接手清单 E2E-webkit-hang，需求记录 R-267 D2）：
// • tools/e2e/run-watchdog.mjs：纯函数（平台→结束办法、阈值越界、只针对 pid、参数解析）；真跑一次——拉起一个不输出的 node 子进程
//   （它再拉一个孙进程），阈值 2 秒，断言退出码 124、子孙都已不在；一直有输出（阈值 5 秒）的不结束；子进程自己退出时退出码原样带出；
//   子进程已退出、孙进程攥着管道时不执行结束命令
// • tests/e2e/global-timeout.ts：E2E_GLOBAL_TIMEOUT_MS 上下限、两组默认值
// • 两个配置真加载出来的 globalTimeout、真后端组 webkit 项目的 actionTimeout、navigationTimeout、workers
// 子进程都经 tools/e2e/run-watchdog.mjs 起（node），登记在 vitest.config.ts 的 SLOW_NODE_TESTS；
// 下面 child_process 的类型 import 让 tests/arch/coverage.test.ts 的 HEAVY 规则认得出本文件起子进程（两边一致，审查必改，10-30）。
// 阈值按机器满载时也稳来定（审查员 48 个忙进程下 300 毫秒阈值 6 次挂 3 次）
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { PlaywrightTestConfig } from '@playwright/test';
import {
  DEFAULT_SILENCE_MS, SILENCE_ENV, SILENCE_EXIT_CODE, killPlan, killTree, parseArgs, portFree, resolveCommand, runWatchdog, silenceMs,
  tickDecision,
} from '../../tools/e2e/run-watchdog.mjs';
import {
  GLOBAL_TIMEOUT_ENV, NO_BACKEND_GLOBAL_TIMEOUT_MS, REAL_GLOBAL_TIMEOUT_MS, REAL_WEBKIT_GLOBAL_TIMEOUT_MS, globalTimeoutMs,
  realGroupDefaultTimeoutMs,
} from '../e2e/global-timeout.ts';
import { REAL_ENV } from '../e2e/real-backend.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const SLOW = { timeout: 30_000 };
/** 只用来让 HEAVY 规则和 SLOW_NODE_TESTS 对得上；子进程类型在这里没有别的用处 */
export type SpawnedByWatchdog = Pick<ChildProcess, 'pid'>;

function sink(): { stream: Writable; text: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pids: number[], ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pids.every((p) => !alive(p))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pids.every((p) => !alive(p));
}

describe('run-watchdog 纯函数', () => {
  it('结束办法：Windows 用 taskkill /PID <pid> /T /F；其他系统打进程组 -pid', () => {
    expect(killPlan('win32', 4321)).toEqual({ kind: 'taskkill', cmd: 'taskkill', args: ['/PID', '4321', '/T', '/F'] });
    expect(killPlan('linux', 4321)).toEqual({ kind: 'group', target: -4321, signal: 'SIGKILL' });
    expect(killPlan('darwin', 7)).toEqual({ kind: 'group', target: -7, signal: 'SIGKILL' });
  });

  it('只针对一个正整数 pid：0、负数、小数、NaN 一律抛错（kill(0)、kill(-1) 会打到整组或所有进程）', () => {
    for (const pid of [0, -1, -4321, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => killPlan('win32', pid), String(pid)).toThrow('pid 必须是正整数');
      expect(() => killPlan('linux', pid), String(pid)).toThrow('pid 必须是正整数');
    }
  });

  it('计时器判定：没到阈值等；到了且子进程还活着才结束；子进程已退出（exitCode 或 signalCode 有值）只收尾、不结束', () => {
    const base = { handled: false, pid: 4321, exitCode: null, signalCode: null, now: 10_000, last: 0, silenceMs: 5000 };
    expect(tickDecision({ ...base, now: 4999 })).toBe('wait');
    expect(tickDecision(base)).toBe('kill');
    expect(tickDecision({ ...base, handled: true })).toBe('wait');
    expect(tickDecision({ ...base, pid: undefined })).toBe('wait');
    expect(tickDecision({ ...base, exitCode: 0 })).toBe('orphaned');
    expect(tickDecision({ ...base, exitCode: 1 })).toBe('orphaned');
    expect(tickDecision({ ...base, signalCode: 'SIGTERM' })).toBe('orphaned');
    expect(tickDecision({ ...base, exitCode: 0, now: 100 })).toBe('wait');
  });

  it('E2E_SILENCE_MS：默认 6 分钟，1～60 分钟之间，越界、非纯十进制抛错', () => {
    expect(DEFAULT_SILENCE_MS).toBe(360_000);
    expect(silenceMs({})).toBe(360_000);
    expect(silenceMs({ [SILENCE_ENV]: '' })).toBe(360_000);
    expect(silenceMs({ [SILENCE_ENV]: '60000' })).toBe(60_000);
    expect(silenceMs({ [SILENCE_ENV]: '3600000' })).toBe(3_600_000);
    for (const v of ['59999', '3600001', '0', '300']) expect(() => silenceMs({ [SILENCE_ENV]: v }), v).toThrow('之间');
    for (const v of ['6m', ' 60000', '6e4', '-60000']) expect(() => silenceMs({ [SILENCE_ENV]: v }), v).toThrow('纯十进制');
  });

  it('参数：[--check-ports a,b] -- 命令…；没有 -- 或 -- 后面是空的拒；端口不合法拒', () => {
    expect(parseArgs(['--', 'playwright', 'test'])).toEqual({ checkPorts: [], command: ['playwright', 'test'] });
    expect(parseArgs(['--check-ports', '8789,9197,9196', '--', 'playwright', 'test', '-c', 'x.ts', '--', 'y'])).toEqual({
      checkPorts: [8789, 9197, 9196],
      command: ['playwright', 'test', '-c', 'x.ts', '--', 'y'],
    });
    expect(() => parseArgs(['playwright', 'test'])).toThrow('用法');
    expect(() => parseArgs(['--'])).toThrow('用法');
    expect(() => parseArgs(['--check-ports', '8789,abc', '--', 'x'])).toThrow('不合法的端口');
    expect(() => parseArgs(['--kill-port', '8789', '--', 'x'])).toThrow('认不出的参数');
  });

  it('命令：node、playwright 换成当前 node（playwright 走 @playwright/test 的 cli.js），不经 shell', () => {
    expect(resolveCommand(['node', '-v'])).toEqual({ file: process.execPath, args: ['-v'] });
    const pw = resolveCommand(['playwright', 'test', '--list']);
    expect(pw.file).toBe(process.execPath);
    expect(pw.args[0]?.replaceAll('\\', '/')).toMatch(/node_modules\/@playwright\/test\/cli\.js$/);
    expect(pw.args.slice(1)).toEqual(['test', '--list']);
  });

  it('源码：不按端口、进程名找或结束进程；package.json 的 e2e、e2e:real 都套了看门狗', () => {
    const code = read('tools/e2e/run-watchdog.mjs')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    for (const bad of ['netstat', 'lsof', 'fuser', 'Get-NetTCPConnection', 'Stop-Process', 'pkill', 'killall', '/IM']) {
      expect(code, bad).not.toContain(bad);
    }
    // process.kill 只有两处：打自己拉起的进程组（killPlan 给的 -pid）和转发 Ctrl+C
    expect([...code.matchAll(/process\.kill\(([^,]+),/g)].map((m) => m[1])).toEqual(['plan.target', '-child.pid']);
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['e2e']).toBe('node tools/e2e/run-watchdog.mjs --check-ports 8788,9199,9198 -- playwright test');
    expect(scripts['e2e:real']).toBe(
      'node tools/e2e/real-backend.mjs check && node tools/e2e/run-watchdog.mjs --check-ports 8789,9197,9196 -- playwright test -c playwright.real.config.ts',
    );
  });
});

describe('run-watchdog 真跑（起 node 子进程，只结束自己拉起的那一棵）', () => {
  it('不输出的子进程（带一个孙进程）：静默 2 秒后结束整棵树，退出码 124，打印静默提示和端口情况', SLOW, async () => {
    const child = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "console.log('PIDS ' + process.pid + ' ' + g.pid);",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const out = sink();
    const err = sink();
    let spawned = 0;
    /** 结束那一刻有没有拿到子孙的 pid：没拿到也照样结束（不留进程），但用例明确判失败，不会卡住 */
    let pidsAtKill: RegExpExecArray | null = null;
    let kills = 0;
    const code = await runWatchdog({
      command: ['node', '-e', child],
      silenceMs: 2000,
      checkPorts: [1],
      out: out.stream,
      err: err.stream,
      onSpawn: (pid) => {
        spawned = pid;
      },
      kill: (k) => {
        kills++;
        pidsAtKill = /PIDS (\d+) (\d+)/.exec(out.text());
        killTree(k);
      },
    });
    expect(kills).toBe(1);
    expect(pidsAtKill, '结束前子进程没来得及打印 PIDS（机器太忙？）').not.toBeNull();
    expect(code).toBe(SILENCE_EXIT_CODE);
    expect(code).toBe(124);
    const m = /PIDS (\d+) (\d+)/.exec(out.text());
    const pids = [Number(m?.[1]), Number(m?.[2])];
    expect(pids[0]).toBe(spawned);
    expect(await gone(pids)).toBe(true);
    expect(err.text()).toContain('静默超过 0.033 分钟（2000 毫秒），已结束本次拉起的进程树');
    expect(err.text()).toContain('端口 1 已释放');
  });

  it('一直有输出的不结束：每 50 毫秒打一行、共 800 毫秒就退出，阈值 5 秒，正常退出 0、输出原样转发', SLOW, async () => {
    const child = "let n = 0; const t = setInterval(() => { console.log('tick ' + n); if (++n === 16) clearInterval(t); }, 50);";
    const out = sink();
    let kills = 0;
    const code = await runWatchdog({
      command: ['node', '-e', child],
      silenceMs: 5000,
      out: out.stream,
      err: sink().stream,
      kill: () => {
        kills++;
      },
    });
    expect(kills).toBe(0);
    expect(code).toBe(0);
    expect(out.text()).toContain('tick 0');
    expect(out.text()).toContain('tick 15');
  });

  it('子进程自己退出：退出码原样带出，标准错误也转发', SLOW, async () => {
    const err = sink();
    const code = await runWatchdog({
      command: ['node', '-e', "console.error('boom'); process.exit(3)"],
      silenceMs: 60_000,
      out: sink().stream,
      err: err.stream,
    });
    expect(code).toBe(3);
    expect(err.text()).toContain('boom');
  });

  it('子进程自己先退出、孙进程攥着输出管道：静默到了也不执行结束命令（pid 可能已被复用），断开管道照常收尾', SLOW, async () => {
    // 孙进程继承子进程的标准输出、标准错误；15 秒后自己退出兜底，用例最后由本测试按它自己报的 pid 结束
    const child = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
      "console.log('PIDS ' + process.pid + ' ' + g.pid);",
      'process.exit(0);',
    ].join('\n');
    const out = sink();
    const err = sink();
    let kills = 0;
    const code = await runWatchdog({
      command: ['node', '-e', child],
      silenceMs: 1500,
      out: out.stream,
      err: err.stream,
      kill: () => {
        kills++;
      },
    });
    const m = /PIDS (\d+) (\d+)/.exec(out.text());
    const grand = Number(m?.[2]);
    try {
      expect(m, '子进程没打印 PIDS').not.toBeNull();
      // 两个平台都成立：不执行结束命令，退出码是子进程自己的 0。
      // POSIX 上孙进程攥着管道，close 要等静默阈值到了由看门狗断开（打印“已自己退出”）；
      // Windows 上子进程一退出 close 就到了，走不到那一支——那一支由上面 tickDecision 的纯函数用例覆盖
      expect(kills).toBe(0);
      expect(code).toBe(0);
      expect(err.text()).not.toContain('已结束本次拉起的进程树');
      if (process.platform !== 'win32') {
        expect(err.text()).toContain('已自己退出');
        expect(err.text()).toContain('看门狗不再结束任何进程');
      }
    } finally {
      // 收拾本测试自己间接拉起的孙进程（只按它报出的 pid）
      if (grand > 0 && alive(grand)) process.kill(grand);
    }
    expect(await gone([grand])).toBe(true);
  });

  it('CI 模式：不计静默，退出码原样带出', SLOW, async () => {
    const code = await runWatchdog({ command: ['node', '-e', 'process.exit(5)'], silenceMs: 60_000, ci: true });
    expect(code).toBe(5);
  });

  it('portFree：有进程在听的端口报“没释放”，只连一下不做别的', SLOW, async () => {
    const { createServer } = await import('node:net');
    const srv = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as { port: number }).port;
    expect(await portFree(port)).toBe(false);
    await new Promise((r) => srv.close(r));
    expect(await portFree(port)).toBe(true);
  });
});

describe('globalTimeout（tests/e2e/global-timeout.ts）', () => {
  it('没设、空字符串用默认；60 秒～60 分钟之间可改；越界、非纯十进制抛错', () => {
    expect(globalTimeoutMs({}, 123)).toBe(123);
    expect(globalTimeoutMs({ [GLOBAL_TIMEOUT_ENV]: '' }, 123)).toBe(123);
    expect(globalTimeoutMs({ [GLOBAL_TIMEOUT_ENV]: '60000' }, 1)).toBe(60_000);
    expect(globalTimeoutMs({ [GLOBAL_TIMEOUT_ENV]: '3600000' }, 1)).toBe(3_600_000);
    for (const v of ['59999', '3600001', '0']) expect(() => globalTimeoutMs({ [GLOBAL_TIMEOUT_ENV]: v }, 1), v).toThrow('之间');
    for (const v of ['15m', '9e5', ' 60000', '-60000']) expect(() => globalTimeoutMs({ [GLOBAL_TIMEOUT_ENV]: v }, 1), v).toThrow('纯十进制');
  });

  it('默认值：无后端组 20 分钟且短于 CI e2e 任务的 timeout-minutes；真后端组 15 分钟，E2E_REAL_WEBKIT=1 时 30 分钟', () => {
    expect(NO_BACKEND_GLOBAL_TIMEOUT_MS).toBe(20 * 60_000);
    expect(REAL_GLOBAL_TIMEOUT_MS).toBe(15 * 60_000);
    expect(REAL_WEBKIT_GLOBAL_TIMEOUT_MS).toBe(30 * 60_000);
    expect(realGroupDefaultTimeoutMs({})).toBe(REAL_GLOBAL_TIMEOUT_MS);
    expect(realGroupDefaultTimeoutMs({ E2E_REAL_WEBKIT: '1' })).toBe(REAL_WEBKIT_GLOBAL_TIMEOUT_MS);
    expect(realGroupDefaultTimeoutMs({ E2E_REAL_WEBKIT: 'true' })).toBe(REAL_GLOBAL_TIMEOUT_MS);
    const ci = read('.github/workflows/ci.yml');
    const job = ci.slice(ci.indexOf('\n  e2e:'));
    const minutes = Number(/timeout-minutes: (\d+)/.exec(job)?.[1]);
    expect(minutes).toBeGreaterThan(0);
    expect(NO_BACKEND_GLOBAL_TIMEOUT_MS).toBeLessThan(minutes * 60_000);
  });
});

describe('两个配置真加载出来的超时设置', () => {
  const fakeBackendEnv = () => {
    vi.stubEnv(REAL_ENV.api, 'http://127.0.0.1:55321');
    vi.stubEnv(REAL_ENV.anonKey, 'fake-anon-for-unit-test');
    vi.stubEnv(REAL_ENV.serviceKey, 'fake-service-for-unit-test');
    vi.stubEnv(REAL_ENV.mailpit, 'http://127.0.0.1:55324');
    vi.stubEnv('LEMO_E2E_FAKE_S3_PORT', '');
    vi.stubEnv('LEMO_E2E_FAKE_SB_PORT', '');
  };
  async function load(file: string, env: Record<string, string>): Promise<PlaywrightTestConfig> {
    vi.resetModules();
    fakeBackendEnv();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    try {
      return (await import(/* @vite-ignore */ `../../${file}`) as { default: PlaywrightTestConfig }).default;
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it('无后端组：默认 20 分钟；E2E_GLOBAL_TIMEOUT_MS 覆盖生效', async () => {
    expect((await load('playwright.config.ts', { [GLOBAL_TIMEOUT_ENV]: '' })).globalTimeout).toBe(20 * 60_000);
    expect((await load('playwright.config.ts', { [GLOBAL_TIMEOUT_ENV]: '120000' })).globalTimeout).toBe(120_000);
  });

  it('真后端组只跑 chromium：15 分钟、只有一个项目', async () => {
    const c = await load('playwright.real.config.ts', { [GLOBAL_TIMEOUT_ENV]: '', E2E_REAL_WEBKIT: '' });
    expect(c.globalTimeout).toBe(15 * 60_000);
    expect(c.projects?.map((p) => p.name)).toEqual(['chromium']);
  });

  it('真后端组 E2E_REAL_WEBKIT=1：30 分钟；webkit 项目 actionTimeout 15 秒、navigationTimeout 30 秒、workers 1', async () => {
    const c = await load('playwright.real.config.ts', { [GLOBAL_TIMEOUT_ENV]: '', E2E_REAL_WEBKIT: '1' });
    expect(c.globalTimeout).toBe(30 * 60_000);
    const webkit = c.projects?.find((p) => p.name === 'webkit');
    expect(webkit?.use?.actionTimeout).toBe(15_000);
    expect(webkit?.use?.navigationTimeout).toBe(30_000);
    expect(webkit?.workers).toBe(1);
    expect(webkit?.use?.defaultBrowserType).toBe('webkit');
    // chromium 项目不受影响
    const chromium = c.projects?.find((p) => p.name === 'chromium');
    expect(chromium?.use?.actionTimeout).toBeUndefined();
    expect(chromium?.workers).toBeUndefined();
  });

  it('源码核对：两个配置都写了 globalTimeout，读的是 global-timeout.ts', () => {
    expect(read('playwright.config.ts')).toContain('globalTimeout: globalTimeoutMs(process.env, NO_BACKEND_GLOBAL_TIMEOUT_MS),');
    expect(read('playwright.real.config.ts')).toContain('globalTimeout: globalTimeoutMs(process.env, realGroupDefaultTimeoutMs(process.env)),');
    const real = read('playwright.real.config.ts');
    expect(real).toContain('actionTimeout: 15_000, navigationTimeout: 30_000');
    expect(real).toMatch(/workers: 1,/);
  });
});
