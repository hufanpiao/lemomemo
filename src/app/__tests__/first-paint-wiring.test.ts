// 首屏画完以后才起的那些事（B2 FA-6 ①；推迟启动代码审查 M1、M2、L1）的接线，按源码文字核对
// （main.tsx 一 import 就会启动整个 App，写法同 splash-release.test.tsx）：
// • watchAppPainted(el, nextFrame) 在 render 之前、读会话之前挂上；render 之后马上 startAppPaintLimit（时限从 render 起算）
// • await appPainted() 在 render 之后、同步 / 设备登记 / 推送认领 / SW 注册之前；紧跟着换账号检查（boot.switching 或本机会话换了人，L6；设 null 推送认领上下文再 return）
// • expectPushClaimContext() 在 render 之前（推迟期间的点按认领先等上下文，L3）
// • 之后用到账号、令牌、推送、设备的调用都在那道检查之后
// • session.ts 的 onAuthUser 预加载 supabase-js 先等首屏画完再等空闲（不是直接 whenIdle）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const strip = (src: string): string => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const main = strip(readFileSync(join(import.meta.dirname, '..', 'main.tsx'), 'utf8'));
const session = strip(readFileSync(join(import.meta.dirname, '..', '..', 'platform', 'session.ts'), 'utf8'));

/** 出现且只出现一次，返回位置 */
function once(src: string, text: string): number {
  const at = src.indexOf(text);
  expect(at, `找不到：${text}`).toBeGreaterThanOrEqual(0);
  expect(src.indexOf(text, at + 1), `出现了不止一次：${text}`).toBe(-1);
  return at;
}

describe('main.tsx：首屏画完以后才起同步、设备登记、推送认领、SW 注册', () => {
  const render = once(main, 'createRoot(el).render(');
  const wait = once(main, 'await appPainted();');

  it('watchAppPainted(el, nextFrame) 在 render 之前、读会话之前挂上', () => {
    const watch = once(main, 'watchAppPainted(el, nextFrame);');
    expect(watch).toBeLessThan(main.indexOf('const userId = readSessionUserId();'));
    expect(watch).toBeLessThan(render);
  });

  it('时限从 render 起算：render 之后、await 之前调 startAppPaintLimit（和告知页关口时限对齐）', () => {
    const limit = once(main, 'startAppPaintLimit(GATE_LIMIT_MS + 1000);');
    expect(limit).toBeGreaterThan(render);
    expect(limit).toBeLessThan(wait);
  });

  const GATE = /^if \(boot\.switching \|\| readSessionUserId\(\) !== userId\) \{\s*setPushClaimContext\(null\);\s*return;\s*\}/;

  it('await appPainted() 在 render 之后，紧跟着换账号检查（boot.switching 或本机会话已不是这个账号，安全复审 L6）：设 null 推送认领上下文再 return（M1、L3）', () => {
    expect(wait).toBeGreaterThan(render);
    const after = main.slice(wait + 'await appPainted();'.length);
    expect(after.trimStart()).toMatch(GATE);
  });

  it('expectPushClaimContext() 在 render 之前、render 前那道换账号检查之后（L3）', () => {
    const exp = once(main, 'expectPushClaimContext();');
    expect(exp).toBeLessThan(render);
    expect(exp).toBeGreaterThan(main.indexOf('if (boot.switching) return;'));
  });

  it('用到账号、令牌、推送、设备的调用都在那道检查之后', () => {
    const rest = main.slice(wait + 'await appPainted();'.length);
    const gate = wait + 'await appPainted();'.length + (rest.length - rest.trimStart().length) + (GATE.exec(rest.trimStart())?.[0].length ?? 0);
    expect(GATE.test(rest.trimStart())).toBe(true);
    for (const call of ['createSupabaseTransport()', 'createDeviceRegistrar(', 'wireSync(boot,', 'setPushClaimContext({', 'registerServiceWorker().then', 'runPushClaim()']) {
      const at = once(main, call);
      expect(at, `${call} 要在 await appPainted() 和换账号检查之后`).toBeGreaterThan(gate);
    }
  });
});

describe('session.ts：onAuthUser 预加载 supabase-js 先等首屏画完', () => {
  it('afterAppPainted 包住 whenIdle，没有直接 whenIdle(... getSupabase ...)', () => {
    const at = once(session, 'afterAppPainted(() => whenIdle(');
    expect(session.slice(at, at + 200)).toContain('getSupabase()');
    const fn = session.slice(session.indexOf('export function onAuthUser('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body.match(/whenIdle\(/g)?.length).toBe(1);
  });
});
