// e2e 看门狗（接手清单 E2E-webkit-hang，需求记录 R-267 D2）：本机跑 e2e 时套在 playwright 外面，连续很久没有输出就结束它。
//
// 用法（package.json 的 e2e、e2e:real 已经套上）：
//   node tools/e2e/run-watchdog.mjs [--check-ports 8789,9197,9196] -- playwright test -c playwright.real.config.ts
// • 拉起 -- 后面的命令，原样转发它的标准输出、标准错误，记最后一次有输出的时间；
// • 连续 E2E_SILENCE_MS（默认 6 分钟，许 1～60 分钟）没有任何输出：结束本次拉起的进程树
//   （Windows：taskkill /PID <子进程 pid> /T /F；其他系统：子进程 detached 成独立进程组，process.kill(-pid, 'SIGKILL')），
//   打印“静默超过 N 分钟，已结束本次拉起的进程树”，退出码 124；
// • 结束以后只“看”--check-ports 列的端口是否已释放（连一下，连得上就是还有进程在听），打印结果，不做任何处理；
// • 子进程自己退出：原样返回它的退出码（被信号结束的算 1）。
//
// ⚠ 只结束自己拉起的那个 pid 和它的子孙进程。绝不按端口、进程名查找或结束进程（不用 netstat、lsof、fuser、Get-NetTCPConnection 之类）：
//   本机常年有别人的服务、别的会话起的 wrangler，端口被占着要本人确认后自己处理。
//
// CI（CI=true）：不计静默、不结束任何进程，stdio 直接继承，只把退出码原样带出来——CI 的 e2e 任务靠 timeout-minutes（ci.yml 30 分钟）
// 和配置里的 globalTimeout（无后端组 20 分钟）收尾。
//
// 命令名：node 换成当前 node（process.execPath），playwright 换成 node + @playwright/test 的 cli.js；不经 shell，参数原样传。
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import process, { argv, env, execPath, exit, platform, stderr, stdout } from 'node:process';
import { clearInterval, setInterval, setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

export const SILENCE_ENV = 'E2E_SILENCE_MS';
export const DEFAULT_SILENCE_MS = 6 * 60_000;
export const SILENCE_MIN_MS = 60_000;
export const SILENCE_MAX_MS = 60 * 60_000;
/** 静默结束时的退出码（和 GNU timeout 一样） */
export const SILENCE_EXIT_CODE = 124;

/**
 * 读 E2E_SILENCE_MS：没设或空字符串用默认 6 分钟；非纯十进制、不在 1～60 分钟之间抛错
 * @param {Readonly<Record<string, string | undefined>>} e
 * @returns {number}
 */
export function silenceMs(e) {
  const raw = e[SILENCE_ENV];
  if (raw === undefined || raw === '') return DEFAULT_SILENCE_MS;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${SILENCE_ENV} 必须是纯十进制毫秒数`);
  const ms = Number(raw);
  if (ms < SILENCE_MIN_MS || ms > SILENCE_MAX_MS) {
    throw new Error(`${SILENCE_ENV} 是 ${ms}，必须在 ${SILENCE_MIN_MS}（1 分钟）～${SILENCE_MAX_MS}（60 分钟）之间`);
  }
  return ms;
}

/**
 * 结束进程树的办法：只针对传进来的这一个 pid（必须是正整数，0、负数、非整数一律抛错——
 * process.kill(0) / kill(-1) 会打到整个进程组或所有进程）
 * @param {string} plat process.platform
 * @param {number} pid 本次拉起的子进程 pid
 * @returns {{ kind: 'taskkill', cmd: string, args: string[] } | { kind: 'group', target: number, signal: 'SIGKILL' }}
 */
export function killPlan(plat, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`pid 必须是正整数（现在是 ${String(pid)}）`);
  if (plat === 'win32') return { kind: 'taskkill', cmd: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  return { kind: 'group', target: -pid, signal: 'SIGKILL' };
}

/**
 * 解析命令行：[--check-ports a,b,c] -- 命令 参数…
 * @param {readonly string[]} args argv.slice(2)
 * @returns {{ checkPorts: number[], command: string[] }}
 */
export function parseArgs(args) {
  const sep = args.indexOf('--');
  if (sep < 0 || sep === args.length - 1) throw new Error('用法：node tools/e2e/run-watchdog.mjs [--check-ports 8789,9197] -- 命令 参数…');
  const own = args.slice(0, sep);
  /** @type {number[]} */
  let checkPorts = [];
  for (let i = 0; i < own.length; i++) {
    if (own[i] === '--check-ports' && own[i + 1] !== undefined) {
      checkPorts = String(own[i + 1])
        .split(',')
        .map((p) => {
          if (!/^[0-9]+$/.test(p) || Number(p) < 1 || Number(p) > 65535) throw new Error(`--check-ports 里有不合法的端口 ${p}`);
          return Number(p);
        });
      i++;
    } else {
      throw new Error(`认不出的参数 ${own[i]}`);
    }
  }
  return { checkPorts, command: args.slice(sep + 1) };
}

/**
 * node → 当前 node；playwright → node + @playwright/test/cli.js；其余原样（不经 shell）
 * @param {readonly string[]} command
 * @returns {{ file: string, args: string[] }}
 */
export function resolveCommand(command) {
  const [head = '', ...rest] = command;
  if (head === 'node') return { file: execPath, args: rest };
  if (head === 'playwright') {
    const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
    return { file: execPath, args: [cli, ...rest] };
  }
  return { file: head, args: rest };
}

/** @param {number} ms */
function minutesText(ms) {
  const min = ms / 60_000;
  return Number.isInteger(min) ? `${min} 分钟` : `${Number(min.toFixed(3))} 分钟（${ms} 毫秒）`;
}

/**
 * 只看端口有没有进程在听（连一下马上断开），不做任何处理
 * @param {number} port
 * @returns {Promise<boolean>} true 表示已释放（连不上）
 */
export function portFree(port) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (/** @type {boolean} */ free) => {
      s.destroy();
      resolve(free);
    };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(false));
    s.once('error', () => done(true));
  });
}

/**
 * 计时器每一跳的判定（纯函数）：
 * • wait：还没到阈值，或已经处理过；
 * • kill：到阈值、子进程还活着 → 结束它的进程树；
 * • orphaned：到阈值，但子进程自己已经退出了（exitCode 或 signalCode 已有值），只是还有子孙进程攥着输出管道——
 *   这时不再对这个 pid 执行任何结束命令（它可能已经被系统分给了别的进程），只断开管道、照常收尾
 * @param {{ handled: boolean, pid: number | undefined, exitCode: number | null, signalCode: string | null, now: number, last: number, silenceMs: number }} s
 * @returns {'wait' | 'kill' | 'orphaned'}
 */
export function tickDecision(s) {
  if (s.handled || !s.pid || s.now - s.last < s.silenceMs) return 'wait';
  if (s.exitCode !== null || s.signalCode !== null) return 'orphaned';
  return 'kill';
}

/**
 * @param {{ pid: number, plat: string }} o
 */
export function killTree({ pid, plat }) {
  const plan = killPlan(plat, pid);
  if (plan.kind === 'taskkill') {
    spawnSync(plan.cmd, plan.args, { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(plan.target, plan.signal);
    } catch {
      // 进程组已经没了
    }
  }
}

/**
 * 跑一次。测试直接调它（silenceMs 可以给很小的值）；命令行入口在文件末尾
 * @param {{
 *   command: readonly string[],
 *   silenceMs: number,
 *   checkPorts?: readonly number[],
 *   ci?: boolean,
 *   plat?: string,
 *   out?: NodeJS.WritableStream,
 *   err?: NodeJS.WritableStream,
 *   onSpawn?: (pid: number) => void,
 *   kill?: (o: { pid: number, plat: string }) => void,
 * }} o
 * @returns {Promise<number>} 退出码
 */
export function runWatchdog(o) {
  const plat = o.plat ?? platform;
  const out = o.out ?? stdout;
  const err = o.err ?? stderr;
  const { file, args } = resolveCommand(o.command);
  if (o.ci) {
    // CI：不计静默、不结束进程，stdio 继承
    return new Promise((resolve) => {
      const child = spawn(file, args, { stdio: 'inherit' });
      child.once('error', (e) => {
        err.write(`run-watchdog：拉不起命令：${e.message}\n`);
        resolve(1);
      });
      child.once('exit', (code) => resolve(code ?? 1));
    });
  }
  return new Promise((resolve) => {
    // POSIX：detached 让子进程自成一个进程组，静默时 kill(-pid) 连子孙一起结束；Windows 上 detached 会另开控制台，不用，靠 taskkill /T
    const child = spawn(file, args, { stdio: ['inherit', 'pipe', 'pipe'], detached: plat !== 'win32', windowsHide: true });
    let last = Date.now();
    let killed = false;
    let closed = false;
    let orphaned = false;
    let settled = false;
    const finish = (/** @type {number} */ code) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve(code);
    };
    child.stdout?.on('data', (d) => {
      last = Date.now();
      out.write(d);
    });
    child.stderr?.on('data', (d) => {
      last = Date.now();
      err.write(d);
    });
    // Ctrl+C：Windows 上同一控制台的子进程自己会收到；POSIX 上子进程在别的进程组，转给它的进程组
    const onSignal = (/** @type {NodeJS.Signals} */ sig) => {
      if (plat !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, sig);
        } catch {
          // 已经退出
        }
      }
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    if (child.pid) o.onSpawn?.(child.pid);
    const tick = Math.max(50, Math.min(1000, Math.floor(o.silenceMs / 4)));
    const timer = setInterval(() => {
      const d = tickDecision({
        handled: killed || orphaned,
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        now: Date.now(),
        last,
        silenceMs: o.silenceMs,
      });
      if (d === 'wait' || !child.pid) return;
      if (d === 'orphaned') {
        orphaned = true;
        err.write(
          `\nrun-watchdog：子进程（pid ${child.pid}）已自己退出，但还有子孙进程攥着输出、静默超过 ${minutesText(o.silenceMs)}；` +
            'pid 可能已被复用，看门狗不再结束任何进程，请本人确认\n',
        );
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (!closed) child.emit('close', child.exitCode, child.signalCode);
        return;
      }
      killed = true;
      (o.kill ?? killTree)({ pid: child.pid, plat });
      // 万一还有子孙进程攥着输出管道、close 一直不来：10 秒后断开管道，照常收尾（还是只动自己拉起的这一棵）
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (!closed) child.emit('close', null, 'SIGKILL');
      }, 10_000).unref();
    }, tick);
    child.once('error', (e) => {
      err.write(`run-watchdog：拉不起命令：${e.message}\n`);
      finish(1);
    });
    child.on('close', (code) => {
      if (closed) return;
      closed = true;
      if (!killed) {
        finish(code ?? 1);
        return;
      }
      err.write(`\nrun-watchdog：静默超过 ${minutesText(o.silenceMs)}，已结束本次拉起的进程树（pid ${child.pid}）\n`);
      const ports = o.checkPorts ?? [];
      Promise.all(ports.map(async (p) => [p, await portFree(p)]))
        .then((rows) => {
          for (const [p, free] of rows) {
            err.write(`run-watchdog：端口 ${p} ${free ? '已释放' : '仍有进程在监听（看门狗不处理，请本人确认后自己处理）'}\n`);
          }
        })
        .finally(() => finish(SILENCE_EXIT_CODE));
    });
  });
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  try {
    const { checkPorts, command } = parseArgs(argv.slice(2));
    const ci = env.CI === 'true';
    const code = await runWatchdog({ command, checkPorts, ci, silenceMs: ci ? DEFAULT_SILENCE_MS : silenceMs(env) });
    exit(code);
  } catch (e) {
    stderr.write(`run-watchdog：${e instanceof Error ? e.message : String(e)}\n`);
    exit(2);
  }
}
