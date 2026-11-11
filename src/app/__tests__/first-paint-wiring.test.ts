// 首屏画完以后才起的那些事（B2 FA-6 ①；推迟启动代码审查 M1、M2、L1）的接线，按源码文字核对
// （main.tsx 一 import 就会启动整个 App，写法同 splash-release.test.tsx）：
// • watchRoot(el, nextFrame)（platform/root-paint.ts，首屏画完检测的唯一出口）在 render 之前、读会话之前挂上；render 之后马上 startAppPaintLimit（时限从 render 起算）
// • await appPainted() 在 render 之后、同步 / 设备登记 / 推送认领 / SW 注册之前；紧跟着换账号检查 stillOwner（boot.switching 或本机会话换了人，L6；设 null 推送认领上下文再 return），
//   startAfterPaint 下载前后用的是同一个 stillOwner
// • expectPushClaimContext() 在 render 之前（推迟期间的点按认领先等上下文，L3）
// • 之后用到账号、令牌、推送、设备的调用都在那道检查之后
// • FA-6 ③：同步、设备登记、账号状态探测的代码在那道检查之后才经 startAfterPaint 下载（失败退避重试、下载前后都过同一道闸，
//   行为测试在 after-paint.test.ts）；用到账号的调用都在 startSync 里、只由 onLoaded 调；SW 注册在第一道闸之后、下载之前（③ 审查 M1）；
//   main.tsx 不再静态 import 它们，日志上传用 lazyLogUploader()
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

  it('watchRoot(el, nextFrame) 在 render 之前、读会话之前挂上', () => {
    const watch = once(main, 'watchRoot(el, nextFrame);');
    expect(watch).toBeLessThan(main.indexOf('const userId = readSessionUserId();'));
    expect(watch).toBeLessThan(render);
  });

  it('时限从 render 起算：render 之后、await 之前调 startAppPaintLimit（和告知页关口时限对齐）', () => {
    const limit = once(main, 'startAppPaintLimit(GATE_LIMIT_MS + 1000);');
    expect(limit).toBeGreaterThan(render);
    expect(limit).toBeLessThan(wait);
  });

  const GATE = /^const stillOwner = \(\): boolean => !boot\.switching && readSessionUserId\(\) === userId;\s*if \(!stillOwner\(\)\) \{\s*setPushClaimContext\(null\);\s*return;\s*\}/;

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

  /** 从 from 起（跳过空白）紧跟着的那道闸的结束位置；不是闸返回 -1 */
  const gateEnd = (from: number): number => {
    const rest = main.slice(from);
    const m = GATE.exec(rest.trimStart());
    return m ? from + (rest.length - rest.trimStart().length) + m[0].length : -1;
  };
  const gate1 = gateEnd(wait + 'await appPainted();'.length);

  it('用到账号、令牌、推送、设备的调用都在那道检查之后', () => {
    expect(gate1).toBeGreaterThan(0);
    for (const call of ['createSupabaseTransport()', 'createDeviceRegistrar(', 'wireSync(boot,', 'setPushClaimContext({', 'registerSw({', 'runPushClaim()']) {
      const at = once(main, call);
      expect(at, `${call} 要在 await appPainted() 和换账号检查之后`).toBeGreaterThan(gate1);
    }
  });

  describe('FA-6 ③：首屏画完以后才下载同步那批代码（③ 审查 M1：重试、SW 注册分开）', () => {
    const swAt = once(main, 'registerSw({');
    const startAt = once(main, 'startAfterPaint({');
    const syncAt = once(main, 'const startSync = (late: AfterPaint): void => {');
    const syncEnd = syncAt + main.slice(syncAt).search(/\n {2}\};\s/);
    const args = main.slice(startAt, startAt + main.slice(startAt).search(/\n {2}\}\);\s/));

    it('SW 注册在第一道闸之后、下载启动件之前，不依赖下载成不成功；startSync 定义在 startAfterPaint 之前', () => {
      expect(swAt).toBeGreaterThan(gate1);
      expect(swAt).toBeLessThan(syncAt);
      expect(syncEnd).toBeGreaterThan(syncAt);
      expect(syncEnd).toBeLessThan(startAt);
      expect(main.slice(gate1, swAt)).not.toMatch(/\bawait\b/);
    });

    it('startAfterPaint：下载 loadAfterPaint，闸和第一道一样，收手、第一次失败都设 null 推送认领上下文，连续失败出 sync-paused 横幅，成功才 startSync', () => {
      expect(startAt).toBeGreaterThan(gate1);
      expect(args).toContain('load: loadAfterPaint,');
      expect(args, '下载前后的闸就是第一道闸那个 stillOwner，不另写一份').toContain('stillOwner,');
      expect(main.match(/readSessionUserId\(\) === userId/g)?.length, '会话主人判断只写一处').toBe(1);
      expect(args).toContain('onAbandoned: () => setPushClaimContext(null),');
      expect(args).toContain('life: browserLifecycle,');
      expect(args).toMatch(/if \(n === 1\) setPushClaimContext\(null\);/);
      expect(args).toMatch(/if \(n === AFTER_PAINT_NOTICE_AT\) uiStore\.getState\(\)\.pushBanner\(\{ id: AFTER_PAINT_BANNER_ID, kind: 'sync-paused' \}\);/);
      expect(args).toMatch(/onLoaded: \(late\) => \{\s*uiStore\.getState\(\)\.dismissBanner\(AFTER_PAINT_BANNER_ID\);\s*startSync\(late\);\s*\}/);
      expect(main.match(/\bstartSync\(/g)?.length, 'startSync 只在 onLoaded 里调').toBe(1);
      expect(main).not.toContain('await loadAfterPaint()');
    });

    it('用到账号的调用都在 startSync 里；startSync 里没有 await（查完闸到用上账号之间没有空档）；推送认领等 SW 注册好、在设上下文之后', () => {
      const body = main.slice(syncAt, syncEnd);
      for (const call of ['createSupabaseTransport()', 'createDeviceRegistrar(', 'wireSync(boot,', 'probeAccountForExit(', 'setPushClaimContext({', 'runPushClaim()']) {
        const at = once(main, call);
        expect(at, `${call} 要在 startSync 里`).toBeGreaterThan(syncAt);
        expect(at, `${call} 要在 startSync 里`).toBeLessThan(syncEnd);
      }
      expect(body).not.toMatch(/\bawait\b/);
      expect(once(main, 'void swReg.then((reg) => {')).toBeGreaterThan(once(main, 'setPushClaimContext({'));
    });

    it('推送认领核对会话主人（L9）读的是本机会话：currentUserId: () => readSessionUserId()，不是闭包里的 userId（首屏审查 M2）', () => {
      const ctx = main.slice(once(main, 'setPushClaimContext({'));
      const args = ctx.slice(0, ctx.indexOf('});'));
      expect(args).toContain('currentUserId: () => readSessionUserId(),');
      expect(main.match(/currentUserId:/g)?.length, 'main.tsx 里 currentUserId 只该出现在 watchAccount 和推送认领上下文两处').toBe(2);
      expect(main).not.toMatch(/currentUserId:\s*\(\)\s*=>\s*userId\b/);
    });

    it('watchAccount 的 currentUserId（K6 换账号监听）也是原样读本机会话：不许兜底成闭包里的 userId（首屏判断复审记录：改成 ?? userId 时没有测试拦）', () => {
      const w = main.slice(once(main, 'watchAccount(boot, {'));
      const args = w.slice(0, w.indexOf('\n  });'));
      expect(args).toMatch(/\n {4}currentUserId: \(\) => readSessionUserId\(\),\n/);
      // 两处 currentUserId 都只能是原样的 readSessionUserId()，后面不许接 ??、||、三元
      expect(main.match(/currentUserId: \(\) => readSessionUserId\(\),/g)?.length).toBe(2);
      expect(main).not.toMatch(/currentUserId:[^\n]*readSessionUserId\(\)\s*(\?\?|\|\||\?)/);
    });

    it('SW 注册真的会执行（③ 复审 L-b）：swReg 就是那个三元式，registerServiceWorker() 只在它的真分支里调一次，不是挪进没人调的函数（11-07 起按需下载再调，11-11 起统一经 sw-register.ts 的 registerSw）', () => {
      expect(main).toMatch(
        /\n {2}const swReg: Promise<ServiceWorkerRegistration \| null> =\s*!import\.meta\.env\.DEV && boot\.status !== 'version_too_new'\s*\?(?:\s*\/\/[^\n]*\n)?\s*registerSw\(\{ onReady: \(\) => boot\.upgrade\.setSwReady\(\), life: browserLifecycle \}\)\.catch\(\(\) => null\)/,
      );
      // 注册本体在 platform/sw-register.ts 的 registerSw（安全审 M1、Q-23：下载、注册都不设超时），main.tsx 只调它这一处；
      // version_too_new 那条路是把同一个 registerSw 原样交给 startRoot（{ registerSw }），不另调
      expect(main.match(/\bregisterSw\(/g)?.length, 'registerSw( 只调这一处').toBe(1);
      once(main, '{ registerSw }');
      expect(main.match(/\bconst swReg\b/g)?.length).toBe(1);
      // 声明在 start 的最外层（两格缩进）、第一道闸之后，不在别的函数里
      const at = once(main, '  const swReg: Promise<ServiceWorkerRegistration | null> =');
      const between = main.slice(gate1, at);
      expect(between, '第一道闸和 swReg 之间开了新的函数').not.toMatch(/=>\s*\{|\bfunction\b/);
    });

    it('下载失败的横幅 id 单独用 after-paint-failed，不和同步引擎的 sync-paused 共用（③ 复审 L-c：共用的话 dismissBanner 会把同步引擎那条一起收掉）', () => {
      once(main, "const AFTER_PAINT_BANNER_ID = 'after-paint-failed';");
      expect(main).not.toMatch(/AFTER_PAINT_BANNER_ID\s*=\s*'sync-paused'/);
      expect(main.match(/pushBanner\(\{ id: AFTER_PAINT_BANNER_ID, kind: 'sync-paused' \}\)/g)?.length).toBe(1);
      expect(main.match(/dismissBanner\(AFTER_PAINT_BANNER_ID\)/g)?.length).toBe(1);
      expect(main, '横幅 id 不许写成字面量').not.toMatch(/(pushBanner\(\{ id|dismissBanner\()\s*'/);
    });

    it('main.tsx 不再静态 import sync-net、sync-wiring、device-reg、account-status；日志上传用 lazyLogUploader()', () => {
      for (const mod of ['platform/sync-net.ts', './sync-wiring.ts', 'core/device-reg.ts', 'platform/account-status.ts', 'zod-jitless']) {
        const esc = mod.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        expect(main, `静态 import 了 ${mod}`).not.toMatch(new RegExp(`^import [^;]*from '[^']*${esc}';`, 'm'));
        expect(main, `副作用 import 了 ${mod}`).not.toMatch(new RegExp(`^import '[^']*${esc}';`, 'm'));
      }
      expect(main).not.toContain('createLogUploader');
      once(main, 'guardOwner(userId, readSessionUserId, lazyLogUploader())');
    });
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
