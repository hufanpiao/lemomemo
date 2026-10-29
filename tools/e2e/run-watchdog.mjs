// e2e 看门狗（接手清单 E2E-webkit-hang，需求记录 R-267 D2）：本机跑 e2e 时套在 playwright 外面，连续很久没有输出就结束它。
//
// 用法（package.json 的 e2e、e2e:real 已经套上）：
//   node tools/e2e/run-watchdog.mjs [--check-ports 8789,9197,9196] -- playwright test -c playwright.real.config.ts
// • 拉起 -- 后面的命令，原样转发它的标准输出、标准错误，记最后一次有输出的时间；
// • 连续 E2E_SILENCE_MS（默认 6 分钟，许 1～60 分钟）没有任何输出：结束本次拉起的进程树
//   （Windows：taskkill /PID <子进程 pid> /T /F；其他系统：子进程 detached 成独立进程组，process.kill(-pid, 'SIGKILL')），
//   打印“静默超过 N 分钟，已结束本次拉起的进程树”，退出码 124；
// • 结束以后只“看”--check-ports 列的端口是否已释放（连一下，连得上就是还有进程在听），打印结果，不做任何处理；
// • 子进程自己退出：原样返回它的退出码（被信号结束的算 1）；
// • 子进程已退出、过了退出宽限（默认 10 秒）输出管道还没关（子孙进程攥着）：判 orphaned，断开管道照常收尾，不再等静默阈值。
//   POSIX 上同时结束它留下的进程组 -pid（组里还有成员时，组号不会被复用；成员都跳出本组时，靠退出宽限只有 10 秒、pid 递增分配来兜底）；
//   Windows 上不结束任何进程；
// • 命令里带 --debug、--ui、--ui-host、--ui-port 或设了 PWDEBUG（调试、界面模式）：和 CI 一样整个透传，见 interactiveFlag。
//
// ⚠ 只结束自己拉起的那个 pid 和它的子孙进程。绝不按端口、进程名查找或结束进程（不用 netstat、lsof、fuser、Get-NetTCPConnection 之类）：
//   本机常年有别人的服务、别的会话起的 wrangler，端口被占着要本人确认后自己处理。
//
// CI（CI=true）：不计静默、不结束任何进程，stdio 直接继承，只把退出码原样带出来——CI 的 e2e 任务靠 timeout-minutes（ci.yml 30 分钟）
// 和配置里的 globalTimeout（无后端组 20 分钟）收尾。
//
// 命令名：node 换成当前 node（process.execPath），playwright、npx playwright 换成 node + @playwright/test 的 cli.js；不经 shell，参数原样传。
// 不经 shell 起 .cmd/.bat（Windows 上的 npx、npm、node_modules/.bin 里的命令）：起不来时 spawnHint 给中文提示该怎么写。
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
/** 子进程 exit 以后等 close（输出管道全关）的宽限 */
export const EXIT_GRACE_MS = 10_000;

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
 * orphaned（子进程已退出、子孙还攥着管道）时收不收残留：Windows 不收（pid 可能已被复用，taskkill /T 找不到已退出进程的子孙）；
 * 其他系统收进程组 -pid：组里还有成员（攥着管道的子孙）时，组号不会被复用；成员都跳出本组（setsid、detached）时，
 * 靠退出宽限只有 10 秒、pid 递增分配来兜底（这么短的时间里同一个号很难被新的进程组用上）
 * @param {string} plat process.platform
 * @param {number} pid 本次拉起的子进程 pid
 * @returns {{ kind: 'none' } | { kind: 'group', target: number, signal: 'SIGKILL' }}
 */
export function orphanPlan(plat, pid) {
  const plan = killPlan(plat, pid);
  return plan.kind === 'group' ? plan : { kind: 'none' };
}

/**
 * 调试、界面模式（要人在终端里操作、停在断点上，静默是正常的）：返回认出的那一项，没有返回 null。
 * --debug、--ui 也认带等号的写法（--ui=true、--debug=…），只有 =false、=0 不算
 * 认出就整个透传（不计静默、不结束进程、stdio 继承、不另起进程组），见 runWatchdog
 * @param {readonly string[]} command
 * @param {Readonly<Record<string, string | undefined>>} e
 * @returns {string | null}
 */
export function interactiveFlag(command, e) {
  const hit = command.find((a) => /^--(?:debug|ui)(?:=(?!(?:false|0)$).*)?$/.test(a) || /^--ui-(?:host|port)(?:=|$)/.test(a));
  if (hit) return hit;
  return e.PWDEBUG !== undefined && e.PWDEBUG !== '' && e.PWDEBUG !== '0' ? 'PWDEBUG' : null;
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
 * node → 当前 node；playwright、npx [-y|--yes] playwright → node + @playwright/test/cli.js；其余原样（不经 shell）
 * @param {readonly string[]} command
 * @returns {{ file: string, args: string[] }}
 */
export function resolveCommand(command) {
  // npx playwright、npx -y playwright、npx --yes playwright：用仓库里锁定的那份；带 @版本、--package= 的照旧不认
  const at = command[1] === '-y' || command[1] === '--yes' ? 2 : 1;
  if (command[0] === 'npx' && command[at] === 'playwright') return resolveCommand(command.slice(at));
  const [head = '', ...rest] = command;
  if (head === 'node') return { file: execPath, args: rest };
  if (head === 'playwright') {
    const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
    return { file: execPath, args: [cli, ...rest] };
  }
  return { file: head, args: rest };
}

/**
 * 拉不起命令时的中文提示（纯函数）。找不到命令（ENOENT）时说明看门狗不经 shell；Windows 上点明 .cmd/.bat 起不来、该怎么写。
 * 不改成经 shell 起 .cmd：cmd.exe 对 % ^ & | " 等的转义规则又多又怪（CVE-2024-27980 一类），参数里有 -g 正则时极易出错
 * @param {{ code?: string, message: string }} e spawn 的 error
 * @param {string} file 实际要起的命令
 * @param {string} plat process.platform
 * @returns {string}
 */
export function spawnHint(e, file, plat) {
  if (e.code !== 'ENOENT') return `拉不起命令：${e.message}`;
  const base = `找不到命令 ${file}（看门狗不经 shell 起命令）`;
  if (plat !== 'win32') return `${base}：确认它在 PATH 里，或写完整路径`;
  return (
    `${base}：Windows 上 npx、npm 和 node_modules/.bin 里的命令都是 .cmd/.bat，不经 shell 起不来。` +
    '请直接写 playwright …（看门狗换成 node + @playwright/test 的 cli.js）、node 脚本路径 …，或写 .exe 的完整路径'
  );
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
 * • wait：没到静默阈值、退出宽限也没过，或已经处理过；
 * • kill：到静默阈值、子进程还活着 → 结束它的进程树；
 * • orphaned：子进程自己已经退出了（exitCode 或 signalCode 已有值），只是还有子孙进程攥着输出管道，且 exit 之后过了宽限
 *   graceMs（exitedAt 是收到 exit 事件的时刻）或到了静默阈值——不再对这个 pid 执行 taskkill，按 orphanPlan 收尾
 * @param {{ handled: boolean, pid: number | undefined, exitCode: number | null, signalCode: string | null, exitedAt: number | null,
 *   now: number, last: number, silenceMs: number, graceMs: number }} s
 * @returns {'wait' | 'kill' | 'orphaned'}
 */
export function tickDecision(s) {
  if (s.handled || !s.pid) return 'wait';
  const exited = s.exitCode !== null || s.signalCode !== null;
  if (exited && s.exitedAt !== null && s.now - s.exitedAt >= s.graceMs) return 'orphaned';
  if (s.now - s.last < s.silenceMs) return 'wait';
  return exited ? 'orphaned' : 'kill';
}

/** @param {{ target: number, signal: NodeJS.Signals }} plan */
function signalGroup(plan) {
  try {
    process.kill(plan.target, plan.signal);
  } catch {
    // 进程组已经没了
  }
}

/**
 * @param {{ pid: number, plat: string }} o
 */
export function killTree({ pid, plat }) {
  const plan = killPlan(plat, pid);
  if (plan.kind === 'taskkill') spawnSync(plan.cmd, plan.args, { stdio: 'ignore', windowsHide: true });
  else signalGroup(plan);
}

/**
 * orphaned 时收残留：按 orphanPlan，Windows 什么也不做
 * @param {{ pid: number, plat: string }} o
 * @returns {'none' | 'group'}
 */
export function reapOrphans({ pid, plat }) {
  const plan = orphanPlan(plat, pid);
  if (plan.kind === 'group') signalGroup(plan);
  return plan.kind;
}

/**
 * 跑一次。测试直接调它（silenceMs 可以给很小的值）；命令行入口在文件末尾
 * @param {{
 *   command: readonly string[],
 *   silenceMs: number,
 *   exitGraceMs?: number,
 *   env?: Readonly<Record<string, string | undefined>>,
 *   checkPorts?: readonly number[],
 *   ci?: boolean,
 *   plat?: string,
 *   out?: NodeJS.WritableStream,
 *   err?: NodeJS.WritableStream,
 *   onSpawn?: (pid: number) => void,
 *   kill?: (o: { pid: number, plat: string }) => void,
 *   reap?: (o: { pid: number, plat: string }) => 'none' | 'group',
 * }} o
 * @returns {Promise<number>} 退出码
 */
export function runWatchdog(o) {
  const plat = o.plat ?? platform;
  const out = o.out ?? stdout;
  const err = o.err ?? stderr;
  const { file, args } = resolveCommand(o.command);
  const graceMs = o.exitGraceMs ?? EXIT_GRACE_MS;
  const debug = o.ci ? null : interactiveFlag(o.command, o.env ?? env);
  if (debug) err.write(`run-watchdog：${debug} 是调试、界面模式，不计静默、不结束进程，原样透传\n`);
  if (o.ci || debug) {
    // CI、调试：不计静默、不结束进程，stdio 继承，和本终端同一进程组（POSIX 上不 detached，读终端不会被 SIGTTIN 停住，Ctrl+C 直达）
    return new Promise((resolve) => {
      const child = spawn(file, args, { stdio: 'inherit' });
      child.once('error', (e) => {
        err.write(`run-watchdog：${spawnHint(e, file, plat)}\n`);
        resolve(1);
      });
      child.once('exit', (code) => resolve(code ?? 1));
    });
  }
  return new Promise((resolve) => {
    // POSIX：detached 让子进程自成一个进程组，静默时 kill(-pid) 连子孙一起结束；Windows 上 detached 会另开控制台，不用，靠 taskkill /T
    const child = spawn(file, args, { stdio: ['inherit', 'pipe', 'pipe'], detached: plat !== 'win32', windowsHide: true });
    let last = Date.now();
    /** @type {number | null} */
    let exitedAt = null;
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
    child.once('exit', () => {
      exitedAt = Date.now();
    });
    const tick = Math.max(50, Math.min(1000, Math.floor(o.silenceMs / 4), Math.floor(graceMs / 4)));
    const timer = setInterval(() => {
      const now = Date.now();
      const s = { handled: killed || orphaned, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, exitedAt, now, last };
      const d = tickDecision({ ...s, silenceMs: o.silenceMs, graceMs });
      if (d === 'wait' || !child.pid) return;
      if (d === 'orphaned') {
        orphaned = true;
        const why = exitedAt !== null && now - exitedAt >= graceMs ? `退出后 ${graceMs / 1000} 秒` : `静默超过 ${minutesText(o.silenceMs)}`;
        const reaped = (o.reap ?? reapOrphans)({ pid: child.pid, plat });
        err.write(
          `\nrun-watchdog：子进程（pid ${child.pid}）已自己退出，但${why}还有子孙进程攥着输出；` +
            (reaped === 'group'
              ? `已结束它留下的进程组（-${child.pid}）\n`
              : 'pid 可能已被复用，看门狗不再结束任何进程，请本人确认\n'),
        );
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (!closed) child.emit('close', child.exitCode, child.signalCode);
        return;
      }
      killed = true;
      (o.kill ?? killTree)({ pid: child.pid, plat });
      // 万一还有子孙进程攥着输出管道、close 一直不来：宽限过后断开管道，照常收尾（还是只动自己拉起的这一棵）
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (!closed) child.emit('close', null, 'SIGKILL');
      }, graceMs).unref();
    }, tick);
    child.once('error', (e) => {
      err.write(`run-watchdog：${spawnHint(e, file, plat)}\n`);
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
