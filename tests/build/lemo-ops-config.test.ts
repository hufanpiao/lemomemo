// lemo-ops 的部署配置核对（架构 6.1、8.4）：wrangler.toml 的 cron 和代码一致、不写密钥；变量样板只有名字；R-270 的版本元数据绑定。
// 要读文件，放在 Node 环境的 tests/build（tests/functions 按 Workers 环境编译，没有 node:fs）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enclosingOpen, firstNonSpace, literalAt, matchClose, matchOpen, scan, splitTop, type Scanned } from './ts-scan-core.ts';

const dir = join(import.meta.dirname, '..', '..', 'workers', 'lemo-ops');
// 不 import index.ts（它用 Workers 的类型，Node 这份 tsconfig 没有），按文本取两个常量
const src = readFileSync(join(dir, 'src', 'index.ts'), 'utf8');
const constOf = (name: string) => new RegExp(`export const ${name} = '([^']+)'`).exec(src)?.[1];
const CRON_HEARTBEAT = constOf('CRON_HEARTBEAT');
const CRON_DAILY = constOf('CRON_DAILY');

/** runScheduled 里唯一允许的非字面量实参（配置错只含变量名、其他只含错误类型名） */
const RUN_SCHEDULED_LOG = "e instanceof Error && e.message.startsWith('lemo-ops 配置') ? e.message : `运行出错：${e instanceof Error ? e.name : 'unknown'}`";

/**
 * 找出 log / consoleLog 的每次调用（含 log?.(…)、名字和括号之间有空白换行）：
 * literal：恰好一个实参、是 ' 或 " 字符串字面量、内容只有 [a-z0-9_:]；bad：既不是这种、也不是 RUN_SCHEDULED_LOG。
 * log.call / .apply / .bind 一律算 bad（arg 记成 .call 之类）。注释、字符串、模板字面部分里的 log( 不算（ts-scan 已换成空格）
 */
function logCalls(code: string): { arg: string; literal: boolean; bad: boolean }[] {
  const sc = scan(code);
  const out: { arg: string; literal: boolean; bad: boolean }[] = [];
  for (const m of sc.skel.matchAll(/(?<![\w$.])(?:log|consoleLog)\s*(\?\.\s*)?([(.])/g)) {
    const at = (m.index ?? 0) + m[0].length - 1;
    if (m[2] === '.') {
      const prop = /^\.\s*([\w$]+)/.exec(sc.skel.slice(at))?.[1] ?? '';
      if (['call', 'apply', 'bind'].includes(prop)) out.push({ arg: `.${prop}`, literal: false, bad: true });
      continue;
    }
    const close = matchClose(sc.skel, at);
    const arg = close < 0 ? sc.text.slice(at + 1) : sc.text.slice(at + 1, close).trim();
    const parts = close < 0 ? [] : splitTop(sc.skel, at, close);
    const start = firstNonSpace(sc.skel, at + 1);
    const lit = parts.length === 1 && sc.skel[start] !== '`' ? literalAt(sc, start) : null;
    const whole = lit !== null && sc.text.slice(start, close).trim() === sc.text.slice(start, start + lit.length + 2);
    const literal = whole && /^[a-z0-9_:]+$/.test(lit ?? '');
    out.push({ arg, literal, bad: !literal && arg.replace(/\s+/g, ' ') !== RUN_SCHEDULED_LOG });
  }
  return out;
}

/** 能原样收 log 的 lemo-ops 自己的函数（log 只能作为最后一个实参交给它们；它们的最后一个参数也叫 log，同样受 logRefs 检查） */
const LOG_SINKS = ['runAlerts', 'parseHeartbeatReport', 'parseAuthMail', 'runDaily', 'runHeartbeat', 'runScheduled'];
/** runScheduled 里按 cron 选函数的那个被调表达式 */
const SCHEDULE_CALLEE = '(cron === CRON_DAILY ? runDaily : runHeartbeat)';

const prevNonSpace = (s: string, at: number) => { let k = at - 1; while (k >= 0 && /\s/.test(s[k] ?? '')) k--; return k; };
/** 开括号 open 是不是函数声明的参数表（前面是 function 名字） */
const isParamList = (skel: string, open: number) => skel[open] === '(' && /\bfunction\s*\*?\s*[\w$]*\s*$/.test(skel.slice(Math.max(0, open - 80), open));

/**
 * OPS-logcalls-gap：log / consoleLog 这两个名字的每一处出现。ok 的只有这几种：
 * 直接调用 log(…)、log?.(…)（实参由 logCalls 查）；函数声明参数表里的 log: … / log?: …；参数默认值 log: LogFn = consoleLog；
 * 顶层的 const consoleLog 定义；原样作为最后一个实参交给 LOG_SINKS 里的函数（或 SCHEDULE_CALLEE）。
 * 其余一律 bad：别名赋值（const l = log）、当回调传出去（xs.forEach(log)、p.catch(log)）、log["call"]、log.call、log?.call、
 * 展开 ...log、{ log } 简写、return log 等。obj.log、obj?.log 是别的对象的属性，不算。注释、字符串里的不算
 */
function logRefs(code: string): { ref: string; ok: boolean }[] {
  const sc = scan(code), sk = sc.skel;
  const out: { ref: string; ok: boolean }[] = [];
  for (const m of sk.matchAll(/(?<![\w$])(log|consoleLog)(?![\w$])/g)) {
    const at = m.index ?? 0, end = at + m[0].length, name = m[1];
    const p = prevNonSpace(sk, at);
    if (sk[p] === '.' && sk[p - 1] !== '.') continue;
    const push = (ok: boolean) => out.push({ ref: sc.text.slice(Math.max(0, at - 24), end + 16).replace(/\s+/g, ' ').trim(), ok });
    const n = firstNonSpace(sk, end);
    if (sk[n] === '(' || (sk.startsWith('?.', n) && sk[firstNonSpace(sk, n + 2)] === '(')) { push(sk[p] !== '.'); continue; }
    const open = enclosingOpen(sk, at);
    if (open >= 0 && isParamList(sk, open)) {
      const close = matchClose(sk, open);
      const seg = splitTop(sk, open, close).find(([a, b]) => a <= at && at < b);
      const segText = seg ? sc.text.slice(seg[0], seg[1]).replace(/\s+/g, ' ').trim() : '';
      push(name === 'log' ? /^log\??\s*:/.test(segText) && seg !== undefined && firstNonSpace(sk, seg[0]) === at : /^log\??\s*:\s*LogFn\s*=\s*consoleLog$/.test(segText));
      continue;
    }
    if (name === 'consoleLog' && open < 0 && /\bconst\s+$/.test(sk.slice(Math.max(0, at - 20), at))) { push(true); continue; }
    if (name === 'log' && open >= 0 && sk[open] === '(') {
      const close = matchClose(sk, open);
      const parts = splitTop(sk, open, close);
      const last = parts[parts.length - 1];
      const isLast = last !== undefined && last[0] <= at && at < last[1] && sc.text.slice(last[0], last[1]).trim() === 'log';
      const c = prevNonSpace(sk, open);
      let callee = '';
      if (sk[c] === ')') callee = sc.text.slice(matchOpen(sk, c), c + 1).replace(/\s+/g, ' ');
      else {
        const id = /[\w$]+$/.exec(sk.slice(0, c + 1))?.[0] ?? '';
        if (sk[prevNonSpace(sk, c + 1 - id.length)] !== '.') callee = id;
      }
      if (isLast && (LOG_SINKS.includes(callee) || callee === SCHEDULE_CALLEE)) { push(true); continue; }
    }
    push(false);
  }
  return out;
}

/**
 * 堵同名遮蔽（OPS-logcalls-gap 复审）：LOG_SINKS 里的名字在 src/ 里只能以 `function 名(` 声明一次；
 * 其余出现只许直接调用 `名(`、不带 as 的 `import { 名 }` / `export { 名 }`，以及 SCHEDULE_CALLEE 里的 runDaily、runHeartbeat。
 * const/let/var 名、as 名（两边都算）、参数名、重复的 function 名(、当值引用一律报。obj.名 是别的对象的属性，不算。
 * code 是 src/ 全部文件接起来的文本（声明唯一要跨文件数）；declOpen 是每个名字那唯一一处声明的参数表开括号下标
 */
function sinkCheck(code: string): { bad: string[]; declOpen: Map<string, number>; sc: Scanned } {
  const sc = scan(code), sk = sc.skel;
  const bad: string[] = [];
  const declOpen = new Map<string, number>();
  const sched: [number, number][] = [];
  for (let k = sc.text.indexOf(SCHEDULE_CALLEE); k >= 0; k = sc.text.indexOf(SCHEDULE_CALLEE, k + 1)) sched.push([k, k + SCHEDULE_CALLEE.length]);
  const wordBefore = (at: number) => /([\w$]+)\s*$/.exec(sk.slice(Math.max(0, at - 40), at))?.[1] ?? '';
  for (const fn of LOG_SINKS) {
    for (const m of sk.matchAll(new RegExp(String.raw`(?<![\w$])${fn}(?![\w$])`, 'g'))) {
      const at = m.index ?? 0, end = at + fn.length;
      const where = `${fn} @ ${sc.text.slice(Math.max(0, at - 24), end + 16).replace(/\s+/g, ' ').trim()}`;
      const p = prevNonSpace(sk, at);
      if (sk[p] === '.' && sk[p - 1] !== '.') continue;
      const n = firstNonSpace(sk, end);
      const before = wordBefore(at), after = /^[\w$]+/.exec(sk.slice(n))?.[0] ?? '';
      if (before === 'function' && sk[n] === '(') {
        if (declOpen.has(fn)) bad.push(`重复声明 ${where}`);
        else declOpen.set(fn, n);
        continue;
      }
      if (before === 'as' || after === 'as') { bad.push(`as ${where}`); continue; }
      if (sk[n] === '(' && !['const', 'let', 'var'].includes(before)) continue;
      const open = enclosingOpen(sk, at);
      if (open >= 0 && sk[open] === '{' && /\b(import|export)\s*(type\s*)?$/.test(sk.slice(Math.max(0, open - 20), open))) continue;
      if (sched.some(([a, b]) => a <= at && at < b)) continue;
      bad.push(where);
    }
  }
  return { bad, declOpen, sc };
}

/** src/ 里禁用 arguments（能绕开参数名拿到 log）：返回出现次数；obj.arguments、注释和字符串里的不算 */
const argumentsRefs = (code: string) => [...scan(code).skel.matchAll(/(?<![\w$.])arguments(?![\w$])/g)].length;

describe('lemo-ops 部署配置', () => {
  it('wrangler.toml 的 cron 和代码里的一致；KV ID 是占位、不含密钥', () => {
    const toml = readFileSync(join(dir, 'wrangler.toml'), 'utf8');
    const crons = /crons\s*=\s*\[([^\]]*)\]/.exec(toml)?.[1] ?? '';
    expect(CRON_HEARTBEAT).toBe('*/15 * * * *');
    expect(crons.split(',').map((s) => s.trim().replace(/^"|"$/g, ''))).toEqual([CRON_HEARTBEAT, CRON_DAILY]);
    expect(toml).toContain('id = "REPLACE_WITH_KV_NAMESPACE_ID"');
    expect(toml).toMatch(/^workers_dev = false/m);
    expect(toml).not.toMatch(/^\s*(OPS_SECRET|RESEND_API_KEY_OPS|SUPABASE_ANON_KEY|SUPABASE_URL|ALERT_TO|ALERT_FROM)\s*=/m);
    expect(toml).not.toMatch(/re_[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{10,}/);
  });

  it('R-261：wrangler.toml 开着 observability（Workers Logs），面板上看得到发信失败的错误码', () => {
    const toml = readFileSync(join(dir, 'wrangler.toml'), 'utf8');
    // 取 [observability] 这一节（到下一个 [ 开头的行为止），里面必须有 enabled = true，且没有 enabled = false
    const sec = /^\[observability\]\s*\r?\n((?:(?!\[).*\r?\n?)*)/m.exec(toml)?.[1];
    expect(sec).toBeDefined();
    expect(sec).toMatch(/^enabled\s*=\s*true\s*(#.*)?$/m);
    expect(sec).not.toMatch(/^enabled\s*=\s*false/m);
    // 采样不能调到 0（等于关掉）
    expect(sec ?? '').not.toMatch(/^head_sampling_rate\s*=\s*0(\.0*)?\s*$/m);
    // traces 明确关着：[observability.traces] 这一节里 enabled = false，且没有 enabled = true
    const traces = /^\[observability\.traces\]\s*\r?\n((?:(?!\[).*\r?\n?)*)/m.exec(toml)?.[1];
    expect(traces).toBeDefined();
    expect(traces).toMatch(/^enabled\s*=\s*false\s*(#.*)?$/m);
    expect(traces).not.toMatch(/^enabled\s*=\s*true/m);
    // 也不许用点号写法在别处把它打开
    expect(toml).not.toMatch(/^\s*(observability\.)?traces\.enabled\s*=\s*true/m);
  });

  it('R-270：声明了 version_metadata 绑定 CF_VERSION_METADATA；不多加 KV 和密钥；正式站地址只在 version.ts 写一处，和发布脚本默认值一致', () => {
    const toml = readFileSync(join(dir, 'wrangler.toml'), 'utf8');
    const sec = /^\[version_metadata\]\s*\r?\n((?:(?!\[).*\r?\n?)*)/m.exec(toml)?.[1];
    expect(sec).toBeDefined();
    expect((sec ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))).toEqual(['binding = "CF_VERSION_METADATA"']);
    expect(toml.match(/^\[version_metadata\]/gm)).toHaveLength(1);
    expect(toml.match(/^\[\[kv_namespaces\]\]/gm)).toHaveLength(1);
    // 代码里用的名字和绑定一致；runHeartbeat 真的把它交给 evaluateVersion
    expect(src).toMatch(/^\s*CF_VERSION_METADATA\?: VersionMetadata;/m);
    expect(src).toContain("Promise.all([callUsageReport(fetchFn, cfg, 'heartbeat'), fetchSiteVersion(fetchFn, now)])");
    expect(src).toContain('evaluateVersion(env.CF_VERSION_METADATA, site)');
    // 正式站地址：src/ 里只有 version.ts 的 SITE_ORIGIN 一处
    const files = readdirSync(join(dir, 'src')).filter((f) => f.endsWith('.ts'));
    const hits = files.flatMap((f) => (readFileSync(join(dir, 'src', f), 'utf8').match(/lemomemo\.com/g) ?? []).map(() => f));
    expect(hits).toEqual(['version.ts']);
    const origin = /^export const SITE_ORIGIN = '([^']+)';$/m.exec(readFileSync(join(dir, 'src', 'version.ts'), 'utf8'))?.[1];
    const ps = readFileSync(join(import.meta.dirname, '..', '..', 'tools', 'release', 'publish.ps1'), 'utf8');
    expect(origin).toBe(/\[string\]\$SiteOrigin = '([^']+)'/.exec(ps)?.[1]);
    expect(origin).toBe('https://lemomemo.com');
  });

  it('R-261：开了日志，src/ 里只有一处 console 输出，只打固定前缀加错误码（不打印收件人、正文、请求和响应）', () => {
    const files = readdirSync(join(dir, 'src')).filter((f) => f.endsWith('.ts')).sort();
    expect(files).toEqual(expect.arrayContaining(['alerts.ts', 'http.ts', 'index.ts', 'mail-fail.ts', 'rules.ts']));
    const hits = files.flatMap((f) => {
      const t = readFileSync(join(dir, 'src', f), 'utf8');
      return [...t.matchAll(/console\.\w+\(.*$/gm)].map((m) => `${f}: ${m[0]}`);
    });
    expect(hits).toEqual(['index.ts: console.error(`lemo-ops: ${code}`);']);
    // log(...) / consoleLog(...) 的实参只能是一个字符串字面量（错误码），或 runScheduled 里那一处（配置错只含变量名、其他只含错误类型名）。
    // OPS-mail-src 余项：按 ts-scan 的扫描结果判断（注释、字符串里的括号不算，嵌套括号、log (x)、log?.(x) 都配得对），不再用正则截到第一个 )
    const found = files.flatMap((f) => logCalls(readFileSync(join(dir, 'src', f), 'utf8')).map((c) => ({ f, ...c })));
    expect(found.filter((c) => c.bad).map((c) => `${c.f}: ${c.arg}`)).toEqual([]);
    expect(found.filter((c) => !c.literal).map((c) => `${c.f}: ${c.arg}`)).toEqual([`index.ts: ${RUN_SCHEDULED_LOG}`]);
    // 扫描真的找到了调用（不是空查）：字面量 alerts.ts 5 处、rules.ts 1 处（log?.），另有 index.ts 那 1 处
    expect(found.filter((c) => c.literal).length).toBeGreaterThanOrEqual(6);
  });

  it('OPS-logcalls-gap：src/ 里 log、consoleLog 除了直接调用，只原样传给 lemo-ops 自己的函数（不当值引用）', () => {
    const files = readdirSync(join(dir, 'src')).filter((f) => f.endsWith('.ts')).sort();
    const refs = files.flatMap((f) => logRefs(readFileSync(join(dir, 'src', f), 'utf8')).map((r) => ({ f, ...r })));
    expect(refs.filter((r) => !r.ok).map((r) => `${r.f}: ${r.ref}`)).toEqual([]);
    expect(refs.length).toBeGreaterThanOrEqual(20);   // 真的扫到了（不是空查）
    // LOG_SINKS 里每个函数在 src/ 里只以 function 名( 声明一次、没有同名遮蔽，那唯一一处的最后一个参数叫 log
    // （于是它们收到的 log 同样受上面的检查）
    const codes = files.map((f) => readFileSync(join(dir, 'src', f), 'utf8'));
    const { bad: shadow, declOpen, sc: all } = sinkCheck(codes.join('\n'));
    expect(shadow).toEqual([]);
    expect(files.filter((_, i) => argumentsRefs(codes[i] ?? '') > 0)).toEqual([]);
    for (const fn of LOG_SINKS) {
      const open = declOpen.get(fn);
      expect(open, fn).toBeDefined();
      if (open === undefined) continue;
      const params = splitTop(all.skel, open, matchClose(all.skel, open));
      const lastParam = params[params.length - 1];
      expect(lastParam ? all.text.slice(lastParam[0], lastParam[1]).trim() : '', fn).toMatch(/^log\??\s*:/);
    }
  });

  it('OPS-logcalls-gap：引用检查的正反例（别名、当回调、下标调用都报，正常写法不报）', () => {
    const bad = (code: string) => logRefs(code).filter((r) => !r.ok).map((r) => r.ref);
    const okCode = [
      'export const consoleLog: LogFn = (code) => console.error(code);',
      "export async function runHeartbeat(env: Env, now: number, log: LogFn = consoleLog) { log('x'); log?.('y'); parseHeartbeatReport(b, log); }",
      'function parseAuthMail(am: unknown, log?: (code: string) => void) { return runAlerts(s, job, evs, now, send, log); }',
      'await (cron === CRON_DAILY ? runDaily : runHeartbeat)(env, fetchFn, now, log);',
      "// const l = log\nconst s = 'xs.forEach(log)'; obj.log(secret); a?.log; catalog(x); logs.push(x);",
    ].join('\n');
    expect(bad(okCode)).toEqual([]);
    // 别名赋值
    expect(bad('const l = log; l(secret);')).toHaveLength(1);
    expect(bad('let l; l = consoleLog;')).toHaveLength(1);
    expect(bad('const { log: l } = deps; const o = { log };')).toHaveLength(2);
    // 当回调传出去
    expect(bad('xs.forEach(log);')).toHaveLength(1);
    expect(bad('p.then(f, log); p.catch(consoleLog);')).toHaveLength(2);
    expect(bad('setTimeout(log, 0, secret); other(log); obj.runAlerts(s, log);')).toHaveLength(3);
    expect(bad('runAlerts(log, s); runAlerts(s, wrap(log)); runAlerts(s, ...log);')).toHaveLength(3);
    // 下标调用和成员访问
    expect(bad('log["call"](null, secret); log[\'apply\'](null, [secret]); log?.["bind"](null);')).toHaveLength(3);
    expect(bad('log.call(null, secret); log?.call(null, secret); log . bind(null);')).toHaveLength(3);
    // 其他取值
    expect(bad('return log; f(...log); const fns = [log];')).toHaveLength(3);
    // 参数表里不是 log 自己的声明（默认值是 log、参数解构）也报
    expect(bad('function f(a = log) {} function g(log2 = consoleLog) {}')).toHaveLength(2);
  });

  it('OPS-logcalls-gap 复审：LOG_SINKS 的同名遮蔽（局部 function、const 箭头、import 别名）和 arguments 都报', () => {
    const shadow = (code: string) => sinkCheck(code).bad;
    const base = 'export async function runAlerts(s: S, log: LogFn) { log(\'x\'); }\n';
    expect(shadow(base + [
      "import { parseHeartbeatReport, type Report } from './rules.ts';",
      'export { runDaily };',
      'runAlerts(s, log); parseHeartbeatReport(b, log); obj.runAlerts(x); a?.runDaily;',
      'await (cron === CRON_DAILY ? runDaily : runHeartbeat)(env, fetchFn, now, log);',
      "// const runAlerts = leak\nconst t = 'function runAlerts(';",
    ].join('\n'))).toEqual([]);
    expect(sinkCheck(base).declOpen.get('runAlerts')).toBe(base.indexOf('('));
    // 局部 function：同名再声明一次
    expect(shadow(base + 'function outer() { function runAlerts(s: S, log: LogFn) { leak(log); } runAlerts(s, log); }')).toEqual([expect.stringMatching(/^重复声明 runAlerts/)]);
    // const 箭头（有没有正经声明都报；没有 function 声明时 declOpen 里也没有它）
    expect(shadow(base + 'const runAlerts = (s: S, log: LogFn) => leak(log);')).toHaveLength(1);
    const arrow = sinkCheck('const runDaily = (e: Env, log: LogFn) => leak(log);');
    expect(arrow.bad).toHaveLength(1);
    expect(arrow.declOpen.has('runDaily')).toBe(false);
    expect(shadow('let runDaily = f; var runHeartbeat = g;')).toHaveLength(2);
    // import 别名：as 两边都算
    expect(shadow("import { leak as runAlerts } from './x.ts';")).toEqual([expect.stringMatching(/^as runAlerts/)]);
    expect(shadow("import { runAlerts as ra } from './alerts.ts'; export { runDaily as rd };")).toHaveLength(2);
    // 参数名就是这个名字、当值引用
    expect(shadow('function f(runAlerts: Fn, log: LogFn) { runAlerts(s, log); }')).toHaveLength(1);
    expect(shadow('const fns = [runAlerts]; xs.map(runDaily); return runScheduled;')).toHaveLength(3);
    // arguments
    expect(argumentsRefs('function f(log: LogFn) { const a = arguments; a[0](secret); }')).toBe(1);
    expect(argumentsRefs("// arguments\nconst s = 'arguments'; obj.arguments; argumentsList;")).toBe(0);
  });

  it('OPS-mail-src 余项：log 实参检查的正反例（嵌套括号、空格、注释和字符串里的假调用、.call 绕过）', () => {
    const bad = (code: string) => logCalls(code).filter((c) => c.bad).map((c) => c.arg);
    expect(bad("log('kv_write_failed'); log?.('auth_mail:bad_resend'); log ( \"mail_send_failed\" );")).toEqual([]);
    expect(bad('// log(secret)\nconst s = "log(secret)"; const t = `log(${1})`;')).toEqual([]);
    expect(bad("log(('code'), secret)")).toEqual(["('code'), secret"]);
    expect(bad("log(f(x) + 'a')")).toEqual(["f(x) + 'a'"]);
    expect(bad("log ('ok' + body)")).toEqual(["'ok' + body"]);
    expect(bad('log\n(`x${y}`)')).toEqual(['`x${y}`']);
    expect(bad("log('a)' + to)")).toEqual(["'a)' + to"]);
    expect(bad("log('Bad Code')")).toEqual(["'Bad Code'"]);
    expect(bad('log.call(null, secret); consoleLog(secret)')).toEqual(['.call', 'secret']);
    expect(bad(`log(${RUN_SCHEDULED_LOG})`)).toEqual([]);
  });

  it('.dev.vars.example 只有变量名、没有值；名字和代码要的一致', () => {
    const txt = readFileSync(join(dir, '.dev.vars.example'), 'utf8');
    const vars = txt.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
    for (const l of vars) expect(l).toMatch(/^[A-Z_0-9]+=$/);
    expect(vars.map((l) => l.slice(0, -1)).sort()).toEqual(['ALERT_FROM', 'ALERT_TO', 'OPS_SECRET', 'RESEND_API_KEY_OPS', 'SUPABASE_ANON_KEY', 'SUPABASE_URL']);
  });
});
