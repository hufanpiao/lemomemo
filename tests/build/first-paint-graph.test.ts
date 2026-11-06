// 首屏不许静态引 zod（B2 FA-6 ③ 审查 M3）：从 src/app/main.tsx 出发只沿静态 import / export … from 走（import()、import type 不算），
// 不许走到 zod（含子路径）、src/platform/zod-jitless.ts（zod 的垫片）、shared/schema/**、shared/manifests/**（都带 zod）。
// ③ 把它们移出首屏后首屏只剩约 4 KB 余量：boot.ts 改回引 rows.ts 的 SCHEMA_V（审查变异 M10）实测首屏 171.8 KB，
// 构建自带的 check_size（静态闭包口径）照样通过，所以这里另外守。M10、M11 两个变异在下面直接模拟，确认拦得住。
// 只读源码，不起子进程。相对引用必须带扩展名、能找到文件（找不到直接失败，不会悄悄漏掉一条边）
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENTRY, forbidden, GRAPH_TIMEOUT_MS, reach, readCached, rel, ROOT, staticSpecs, strip, violations, withPatch, type Read } from './first-paint-lib.ts';


describe('首屏（src/app/main.tsx 的静态 import 闭包）不碰 zod（③ 审查 M3）', { timeout: GRAPH_TIMEOUT_MS }, () => {
  it('走不到 zod、zod-jitless、shared/schema、shared/manifests；相对引用都找得到文件', () => {
    const { prev, missing } = reach(ENTRY);
    expect(missing).toEqual([]);
    expect(prev.size, '图太小，可能没走起来').toBeGreaterThan(50);
    expect(violations(ENTRY)).toEqual([]);
  });

  it('拦得住审查变异 M10：boot.ts 改回从 rows.ts 引 SCHEMA_V', () => {
    const read = withPatch('src/core/boot.ts', (s) => s.replace("import { SCHEMA_V } from './schema-version.ts';", "import { SCHEMA_V } from '../../shared/schema/rows.ts';"));
    expect(read(resolve(ROOT, 'src/core/boot.ts'))).toContain('shared/schema/rows.ts');
    const v = violations(ENTRY, read);
    expect(v.some((p) => p.includes('src/core/boot.ts → shared/schema/rows.ts'))).toBe(true);
    expect(v.some((p) => p.endsWith('pkg:zod'))).toBe(true);
  });

  it('拦得住审查变异 M11：首屏建本机仓的清单改回读 shared/manifests（11-05 起首屏入口是 cache-schema.ts，manifest-source.ts 已不在首屏）', () => {
    const read = withPatch('src/core/cache-schema.ts', (s) => `import { allManifests } from '../../shared/manifests/index.ts';\n${s}`);
    expect(violations(ENTRY, read).some((p) => p.includes('src/core/cache-schema.ts → shared/manifests/'))).toBe(true);
  });
});

describe('静态 import 的认法', () => {
  it('import type、花括号里全是 type 的不算；混着值的、副作用 import、export … from、多行的都算；import() 不算；注释里的不算', () => {
    const src = [
      "import type { A } from './a.ts';",
      "import { type B, type C } from './b.ts';",
      "import { type D, e } from './d.ts';",
      "import './side.ts';",
      "export * from './star.ts';",
      "export { f } from './f.ts';",
      "export type { G } from './g.ts';",
      'import {',
      '  h,',
      '  i,',
      "} from './hi.ts';",
      "const lazyOne = () => import('./lazy.ts');",
      "// import { x } from './comment.ts';",
      "/* import { y } from './block.ts'; */",
      "import z from 'zod';",
      "import w from 'zod/v4';",
    ].join('\n');
    expect(staticSpecs(src)).toEqual(['./d.ts', './side.ts', './star.ts', './f.ts', './hi.ts', 'zod', 'zod/v4']);
  });

  it('不许到的：zod 和子路径、垫片、shared/schema、shared/manifests；shared 里别的（i18n、logic）可以', () => {
    expect(forbidden('pkg:zod')).toBe(true);
    expect(forbidden('pkg:zod/v4')).toBe(true);
    expect(forbidden('pkg:zodiac')).toBe(false);
    expect(forbidden(resolve(ROOT, 'src/platform/zod-jitless.ts'))).toBe(true);
    expect(forbidden(resolve(ROOT, 'shared/schema/rows.ts'))).toBe(true);
    expect(forbidden(resolve(ROOT, 'shared/manifests/core.ts'))).toBe(true);
    expect(forbidden(resolve(ROOT, 'shared/i18n/zh.ts'))).toBe(false);
  });
});

// —— 首屏动态入口名单（FA-6 ③ 审查 M3 第三轮）——
// build/check_first_paint_chunks.mjs 的 FIRST_PAINT_DYNAMIC 是手写名单，漏登了 MissedReminders（审查员变异 R3b 首屏 203.5 KB 没人拦）。
// 这里从源码推：从 main.tsx 的静态闭包出发，收集里面每一个 import('…')；路由表里的 Page: lazy(import(…)) 只有冷启动那一页（今天页）算首屏，
// 别的路由页要点进去才下载，跳过。其余每个 import() 的目标都必须归类——要么在 FIRST_PAINT_DYNAMIC（首屏期间会下载，名单检查要跟进去，
// 它自己的静态闭包也接着往下推），要么在 NOT_FIRST_PAINT（写明为什么不在首屏下载）。新加的懒加载块谁都没归类，这里就挂。
// 归类只是第一道、靠人判断；首屏期间实际下载了什么，由 e2e tests/e2e/b2-first-screen-budget.spec.ts 按页面时钟兜底
const ROUTE_LAZY = /\bPage:\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;
const DYNAMIC = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 不在首屏下载的动态入口（相对仓库根）→ 原因 */
const NOT_FIRST_PAINT: Record<string, string> = {
  'src/core/device-reg.ts': '首屏画完以后 startAfterPaint 才下载（FA-6 ③，app/after-paint.ts）',
  'src/platform/account-status.ts': '告知页关口的 consent-exit.ts 静态引用了它，本来就在首屏（体积已算进页面时钟）；after-paint 里这次 import() 只是取引用，不再发请求（第四轮审查 L-d）',
  'src/platform/sync-net.ts': '同上，首屏画完以后才下载',
  'src/app/sync-wiring.ts': '同上，首屏画完以后才下载',
  'shared/schema/rows.ts': 'loadRowSchemas：首屏画完以后 loadAfterPaint 预加载，写入时才等（FA-6 ③）',
  'src/core/outbox-new-item.ts': '建新 outbox 项（K8 R2 ①）：和 rows.ts 一起在 loadRowSchemas 里按需加载，不进首屏',
  'src/core/manifest-source.ts': '完整清单快照：和 rows.ts 一起在 loadRowSchemas 里按需加载（首屏瘦身 11-05，首屏建本机仓只读 manifest-sync.gen.ts）',
  'src/platform/desktop.ts': '只在 exe（Tauri）里加载，网页版不下载',
  'src/app/CacheTooNewScreen.tsx': '只在本机库比 App 新（version_too_new）时整屏提示用',
  'src/motion/feature-bundle.ts': 'LazyMotion 在 useEffect 里调加载函数，今天页画出来以后才下载（FA-6 ②）',
  'src/features/reminders/ui/RemindHost.tsx': '首屏画完 + 浏览器空闲以后才挂（App.tsx 首屏减重 ⑥）',
  'src/features/reminders/ui/RemindSettings.tsx': '设置页里用',
  'src/features/reminders/ui/RemindSettingsValue.tsx': '设置页里用',
  'src/features/reminders/ui/RemindShowTitle.tsx': '设置 › 提醒里点进去才用',
  'src/features/reminders/ui/RemindDnd.tsx': '设置 › 提醒里点进去才用',
  'src/features/reminders/ui/RemindUpcoming.tsx': '设置 › 提醒里点进去才用',
  'src/features/reminders/ui/ClockWrongNote.tsx': '设置 › 关于里用',
  'src/features/calendar/ui/CalendarSettings.tsx': '设置页里用',
  'src/features/calendar/ui/CalendarSettingsValue.tsx': '设置页里用',
  'src/app/UpdateBanner.tsx': '顶部版本横幅本体：有横幅要出时才下载（App.tsx 的 BannerGate，首屏瘦身 11-05）',
  'src/app/ExitIncompleteScreen.tsx': 'exe 里会话出问题的整屏提示：真要挂出时才下载（exit-screen.tsx，首屏瘦身 11-05）',
  'src/platform/push.ts': '断开浏览器推送：只在退出、被移除、换账号时下载（push-disconnect.ts，首屏瘦身 11-05）',
  'src/platform/push-claim.ts': '推送认领本体：首屏画完设好上下文、真要认领时才下载（首屏瘦身 11-05）',
  'src/features/reminders/ui/MissedSheet.tsx': '错过提醒的底部弹层：点开才下载，有错过时首屏画完、浏览器空闲才预取（前端 B 11-05 拆出）',
  'src/features/today/ui/TodayToasts.tsx':
    '今天页页底提示条（撤销条、出错条、只读提示条）和重复事项横幅：真有一条提示、或有只读行时才下载（FA-2 返工，首屏预算；连着 UndoToast、只读横幅一起不进首屏）',
  'src/platform/viewport.ts': '键盘检测：底栏在键盘弹起时藏起来用（FA-7 第 3 项），首屏画完以后 afterAppPainted 才下载',
  'src/kit/components/GlassBar/GlassBarFx.tsx':
    '液态玻璃底栏的首屏后部分：模糊带、果冻、按住放大；首屏画完以后 afterAppPainted 才下载，挂上以后再 import() 内容副本、自动深浅、帧循环（motion/glass-ghost.ts）（B2 FA-7，主持人 11-05 首屏 ③；没下载到时外壳用 backdrop-filter 后备）',
};

/** 从入口出发推首屏会碰到的 import()：返回已归类为首屏的、归类为非首屏的、没归类的（带出处） */
function classifyDynamics(first: string[], read: Read = readCached): { first: string[]; not: string[]; unclassified: string[] } {
  const firstAbs = new Set(first.map((k) => resolve(ROOT, 'src', k)));
  const roots = [ENTRY];
  const scanned = new Set<string>();
  const hitFirst = new Set<string>();
  const hitNot = new Set<string>();
  const unclassified: string[] = [];
  while (roots.length) {
    const root = roots.shift() as string;
    for (const f of reach(root, read).prev.keys()) {
      if (f.startsWith('pkg:') || scanned.has(f) || !/\.(ts|tsx)$/.test(f)) continue;
      scanned.add(f);
      const src = strip(read(f));
      const routes = new Set([...src.matchAll(ROUTE_LAZY)].map((m) => m[1]));
      for (const m of src.matchAll(DYNAMIC)) {
        const spec = m[1] ?? '';
        if (!spec.startsWith('.')) continue;
        const to = resolve(dirname(f), spec);
        if (firstAbs.has(to)) {
          if (!hitFirst.has(to)) roots.push(to);
          hitFirst.add(to);
        } else if (routes.has(spec)) continue;   // 别的路由页：点进去才下载
        else if (rel(to) in NOT_FIRST_PAINT) hitNot.add(rel(to));
        else unclassified.push(`${rel(f)} → ${spec}`);
      }
    }
  }
  return { first: [...hitFirst].map(rel).sort(), not: [...hitNot].sort(), unclassified: [...new Set(unclassified)].sort() };
}

describe('首屏动态入口名单和源码对得上（③ 审查 M3 第三轮）', { timeout: GRAPH_TIMEOUT_MS }, () => {
  it('main.tsx 静态闭包（和首屏名单里各块的闭包）里的每个 import() 都归了类；名单里的都推得到，非首屏名单里没有过时的', async () => {
    const { FIRST_PAINT_DYNAMIC } = (await import('../../build/check_first_paint_chunks.mjs')) as { FIRST_PAINT_DYNAMIC: string[] };
    const r = classifyDynamics(FIRST_PAINT_DYNAMIC);
    expect(r.unclassified, '这些 import() 没归类：首屏期间会下载的加进 build/check_first_paint_chunks.mjs 的 FIRST_PAINT_DYNAMIC，不会的加进 NOT_FIRST_PAINT 并写原因').toEqual([]);
    expect(r.first, 'FIRST_PAINT_DYNAMIC 里有从首屏推不到的').toEqual(FIRST_PAINT_DYNAMIC.map((k) => `src/${k}`).sort());
    expect(r.not, 'NOT_FIRST_PAINT 里有已经不存在的').toEqual(Object.keys(NOT_FIRST_PAINT).sort());
  });
});

describe('完整清单快照不进首屏（首屏瘦身 11-05）', { timeout: GRAPH_TIMEOUT_MS }, () => {
  const SNAP = resolve(ROOT, 'src/core/manifests.gen.ts');
  it('main.tsx 的静态闭包到不了 manifests.gen.ts、manifest-source.ts、manifest.ts；建本机仓用的 manifest-sync.gen.ts 在里面', () => {
    const { prev } = reach(ENTRY);
    expect(prev.has(SNAP)).toBe(false);
    expect(prev.has(resolve(ROOT, 'src/core/manifest-source.ts'))).toBe(false);
    expect(prev.has(resolve(ROOT, 'src/core/manifest.ts'))).toBe(false);
    expect(prev.has(resolve(ROOT, 'src/core/manifest-sync.gen.ts'))).toBe(true);
  });

  it('拦得住变异：cache-schema.ts 改回从 manifest.ts 引 syncTables', () => {
    const read = withPatch('src/core/cache-schema.ts', (s) => `import { syncTables as _full } from './manifest.ts';\nvoid _full;\n${s}`);
    expect(reach(ENTRY, read).prev.has(SNAP)).toBe(true);
  });
});

describe('时区词典不进首屏（11-05，tz.* 挪出公共词典）', { timeout: GRAPH_TIMEOUT_MS }, () => {
  it('main.tsx 和首屏名单里各块的静态闭包都到不了 tz-label.ts、tz-zh.ts、tz-ko.ts（只给登录页恢复页、邮件用）', async () => {
    const { FIRST_PAINT_DYNAMIC } = (await import('../../build/check_first_paint_chunks.mjs')) as { FIRST_PAINT_DYNAMIC: string[] };
    const tz = ['shared/i18n/tz-label.ts', 'shared/i18n/tz-zh.ts', 'shared/i18n/tz-ko.ts'].map((f) => resolve(ROOT, f));
    for (const root of [ENTRY, ...FIRST_PAINT_DYNAMIC.map((k) => resolve(ROOT, 'src', k))]) {
      const { prev } = reach(root);
      expect(tz.filter((f) => prev.has(f)).map(rel), rel(root)).toEqual([]);
    }
  });
});

describe('只读行的词典和部件不进首屏（11-06，FA-2 返工，首屏预算 150 KB）', { timeout: GRAPH_TIMEOUT_MS }, () => {
  const RO = ['shared/i18n/ro-zh.ts', 'shared/i18n/ro-ko.ts', 'src/kit/components/ReadonlyRow.tsx', 'src/kit/components/UndoToast.tsx'].map((f) => resolve(ROOT, f));
  it('main.tsx 和首屏名单里各块的静态闭包都到不了 ro-zh.ts、ro-ko.ts、ReadonlyRow.tsx、UndoToast.tsx（今天页经 TodayToasts.tsx 按需下载）', async () => {
    const { FIRST_PAINT_DYNAMIC } = (await import('../../build/check_first_paint_chunks.mjs')) as { FIRST_PAINT_DYNAMIC: string[] };
    expect(FIRST_PAINT_DYNAMIC, '今天页不在首屏名单里了，这条守护要跟着改').toContain('features/today/ui/TodayPage.tsx');
    for (const root of [ENTRY, ...FIRST_PAINT_DYNAMIC.map((k) => resolve(ROOT, 'src', k))]) {
      const { prev } = reach(root);
      expect(RO.filter((f) => prev.has(f)).map(rel), rel(root)).toEqual([]);
    }
  });
  it('拦得住变异：今天页改回直接引 ReadonlyRow.tsx', () => {
    const read = withPatch('src/features/today/ui/TodayPage.tsx', (s) => `import { RoCheckCircle as _ro } from '../../../kit/components/ReadonlyRow.tsx';\nvoid _ro;\n${s}`);
    expect(reach(resolve(ROOT, 'src/features/today/ui/TodayPage.tsx'), read).prev.has(RO[0] ?? '')).toBe(true);
  });
});

describe('液态玻璃的副本引擎、帧循环不进首屏（B2 FA-7，底栏外壳代码审查）', { timeout: GRAPH_TIMEOUT_MS }, () => {
  const GHOST = resolve(ROOT, 'src/motion/glass-ghost.ts');
  const BAR = 'src/kit/components/GlassBar/GlassBar.tsx';
  const FX = resolve(ROOT, 'src/kit/components/GlassBar/GlassBarFx.tsx');
  it('main.tsx 和首屏名单里各块的静态闭包都到不了 motion/glass-ghost.ts 和底栏首屏后部分 GlassBarFx.tsx；底栏外壳本身在首屏里', async () => {
    const { FIRST_PAINT_DYNAMIC } = (await import('../../build/check_first_paint_chunks.mjs')) as { FIRST_PAINT_DYNAMIC: string[] };
    expect(reach(ENTRY).prev.has(resolve(ROOT, BAR)), '底栏外壳不在首屏闭包里了，这条守护要跟着改').toBe(true);
    for (const root of [ENTRY, ...FIRST_PAINT_DYNAMIC.map((k) => resolve(ROOT, 'src', k))]) {
      const { prev } = reach(root);
      expect(prev.has(GHOST), rel(root)).toBe(false);
      expect(prev.has(FX), rel(root)).toBe(false);
    }
  });

  it('拦得住变异：GlassBar.tsx 改成静态引首屏后部分（模糊带、果冻跟着进首屏，主持人 11-05 首屏 ③）', () => {
    const read = withPatch(BAR, (s) => `import { GlassBarFx as _f } from './GlassBarFx.tsx';\nvoid _f;\n${s}`);
    expect(reach(ENTRY, read).prev.has(FX)).toBe(true);
  });

  it('拦得住变异：GlassBar.tsx 改成静态引 glass-ghost.ts', () => {
    const read = withPatch(BAR, (s) => `import { startGlass as _g } from '../../../motion/glass-ghost.ts';\nvoid _g;\n${s}`);
    expect(reach(ENTRY, read).prev.has(GHOST)).toBe(true);
  });
});

describe('首屏名单里各个动态入口的静态闭包也不碰 zod（③ 审查第三轮）', { timeout: GRAPH_TIMEOUT_MS }, () => {
  const roots = async (): Promise<string[]> =>
    ((await import('../../build/check_first_paint_chunks.mjs')) as { FIRST_PAINT_DYNAMIC: string[] }).FIRST_PAINT_DYNAMIC.map((k) => resolve(ROOT, 'src', k));

  it('今天页、告知页关口、告知页、错过提醒、未同步提示和小标记：各自走不到 zod、zod-jitless、shared/schema、shared/manifests', async () => {
    for (const r of await roots()) expect(violations(r), rel(r)).toEqual([]);
  });

  it('拦得住审查变异 R3b：MissedReminders.tsx 静态引 rows.ts', async () => {
    const file = 'src/features/reminders/ui/MissedReminders.tsx';
    const read = withPatch(file, (s) => `import { SNOOZE_AT_MAX } from '../../../../shared/schema/rows.ts';\nvoid SNOOZE_AT_MAX;\n${s}`);
    const v = (await roots()).flatMap((r) => violations(r, read));
    expect(v.some((p) => p.includes(`${file} → shared/schema/rows.ts`))).toBe(true);
  });

  it('首屏路径上新加一个没归类的 import()（例如今天页里新懒加载一个部件）：报“没归类”', async () => {
    const { FIRST_PAINT_DYNAMIC } = (await import('../../build/check_first_paint_chunks.mjs')) as { FIRST_PAINT_DYNAMIC: string[] };
    const file = 'src/features/today/ui/TodayPage.tsx';
    const read = withPatch(file, (s) => `${s}\nexport const NewWidget = () => import('./NowCard.tsx');\n`);
    expect(classifyDynamics(FIRST_PAINT_DYNAMIC).unclassified).toEqual([]);
    expect(classifyDynamics(FIRST_PAINT_DYNAMIC, read).unclassified.some((u) => u.includes('NowCard'))).toBe(true);
  });
});
