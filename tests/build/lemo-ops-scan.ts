// lemo-ops 源码里 log / consoleLog 的扫描（tests/build/lemo-ops-config.test.ts 用）：实参只能是错误码字面量（logCalls）、
// 不许当值引用（logRefs）、能收 log 的函数不许被同名遮蔽（sinkCheck）、不许用 arguments（argumentsRefs）。
// 从 lemo-ops-config.test.ts 拆出来免超 max-lines（OPS-logcalls-gap 余项，12 批），测试文件只留用例。
// 照 ts-scan-core.ts 的写法：纯文本扫描，不 import typescript、不读文件、不起子进程。
import { enclosingOpen, firstNonSpace, literalAt, matchClose, matchOpen, scan, splitTop, type Scanned } from './ts-scan-core.ts';

/** runScheduled 里唯一允许的非字面量实参（配置错只含变量名、其他只含错误类型名） */
export const RUN_SCHEDULED_LOG = "e instanceof Error && e.message.startsWith('lemo-ops 配置') ? e.message : `运行出错：${e instanceof Error ? e.name : 'unknown'}`";

/**
 * 找出 log / consoleLog 的每次调用（含 log?.(…)、名字和括号之间有空白换行）：
 * literal：恰好一个实参、是 ' 或 " 字符串字面量、内容只有 [a-z0-9_:]；bad：既不是这种、也不是 RUN_SCHEDULED_LOG。
 * log.call / .apply / .bind 一律算 bad（arg 记成 .call 之类）。注释、字符串、模板字面部分里的 log( 不算（ts-scan 已换成空格）
 */
export function logCalls(code: string): { arg: string; literal: boolean; bad: boolean }[] {
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
export const LOG_SINKS = ['runAlerts', 'parseHeartbeatReport', 'parseAuthMail', 'runDaily', 'runHeartbeat', 'runScheduled'];
/** runScheduled 里按 cron 选函数的那个被调表达式 */
export const SCHEDULE_CALLEE = '(cron === CRON_DAILY ? runDaily : runHeartbeat)';

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
export function logRefs(code: string): { ref: string; ok: boolean }[] {
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
export function sinkCheck(code: string): { bad: string[]; declOpen: Map<string, number>; sc: Scanned } {
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
export const argumentsRefs = (code: string) => [...scan(code).skel.matchAll(/(?<![\w$.])arguments(?![\w$])/g)].length;
