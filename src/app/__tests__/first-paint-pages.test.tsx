// FIRSTPAINT-nofeature（提醒挂载统一审查 F1）：首屏判断的选择器放宽成 'main' 以后，根是不带 data-feature 的 <main> 的页面也算画完
// • EditShell（编辑页）、FullReminderPage（整页提醒，冷启动最常见的入口）真渲染出来，根能被 APP_PAGE_SELECTOR 认出
// • 扫源码：不带 data-feature 的 <main> 只许出现在登记过的页面里，新增的要先想清楚它是不是页面（不是页面就别用 main，会提前触发“画完”）
// App 外壳里不能有常驻 <main> 的运行时检查在 first-paint-shell.test.tsx（那边不能带这里的提醒替身）
import { cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_PAGE_SELECTOR } from '../../platform/first-paint.ts';
// outbox 状态替身的空集合（UNSYNCED-retryRecs-required）：每次返回同一个对象，useSyncExternalStore 的快照才稳定
const EMPTY_RECS = vi.hoisted((): ReadonlySet<string> => new Set());

// 整页提醒要的替身（照 src/features/reminders/__tests__/RemindViews.test.tsx 的同一套，只留渲染“这条提醒找不到了”要的）
vi.mock('../../kit/hooks/useCollection.ts', () => ({ useCollection: () => [] }));
vi.mock('../../core/current-tz.ts', () => ({ currentTz: () => 'Asia/Seoul' }));
vi.mock('../../platform/clock.ts', () => ({
  clock: { now: () => 0, subscribe: () => () => undefined, offset: () => 0, isClockWrong: () => false },
}));
vi.mock('../../platform/native-bridge.ts', () => ({ openReminder: vi.fn(async () => undefined), showLocalReminder: vi.fn(), closeLocalReminder: vi.fn() }));
vi.mock('../router.ts', () => ({ canGoBack: () => false, goBack: vi.fn(), navigate: vi.fn(async () => undefined) }));
vi.mock('../../core/boot.ts', () => ({
  getBoot: () => ({ outbox: { subscribe: () => () => undefined, getStatus: () => ({ retryRecs: EMPTY_RECS, remindRecs: EMPTY_RECS }) } }),
}));

// app 只许经功能的 index.ts 拿懒加载的页面（A27），所以包一层 Suspense
const { FullReminderPage } = await import('../../features/reminders/index.ts');
const { EditShell } = await import('../../kit/components/EditShell.tsx');

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

// 两组都给 20 秒（FA-6 ③ 第四轮审查 L-e：首次 import 页面、扫整个 src 在机器满载时会超过默认 5 秒；单跑都在 1 秒左右）
describe('根是不带 data-feature 的 <main> 的页面也算画完', { timeout: 20_000 }, () => {
  it('EditShell（编辑页）', () => {
    const { container } = render(
      <EditShell kind="待办" backLabel="返回" onBack={() => undefined} status="">
        <p>正文</p>
      </EditShell>,
    );
    const page = container.querySelector(APP_PAGE_SELECTOR);
    expect(page).not.toBeNull();
    expect(page?.parentElement).toBe(container);
    expect(page?.hasAttribute('data-feature')).toBe(false);
  });

  it('FullReminderPage（整页提醒；地址不合格时显示“这条提醒找不到了”，根照样是 main）', async () => {
    window.location.hash = '#/remind/event/x';
    const { container } = render(
      <Suspense fallback={null}>
        <FullReminderPage />
      </Suspense>,
    );
    await screen.findByTestId('remind-full', {}, { timeout: 10_000 });
    const page = container.querySelector(APP_PAGE_SELECTOR);
    expect(page).not.toBeNull();
    expect(page?.parentElement).toBe(container);
    expect(page?.getAttribute('data-testid')).toBe('remind-full');
  });
});

const SRC = resolve(import.meta.dirname, '..', '..');
/** 根是不带 data-feature 的 <main> 的页面（登记在这里，first-paint.ts 文件头同步写着） */
// app/dev/VoiceProbe.tsx：R-68 探测页（B3 FA-0，非正式版 #/dev-csp/voice，一次性，和 voice-probe 同一个 PR 删）
const PAGES_WITHOUT_FEATURE = ['app/dev/CspLab.tsx', 'app/dev/VoiceProbe.tsx', 'features/reminders/ui/FullReminderPage.tsx', 'kit/components/EditShell.tsx'];

/**
 * 允许出现 main 的文件（带不带 data-feature 都算）：都是页面的根（首屏判断放宽与推送认领核对审查 L4）。
 * 外壳（App.tsx 里页面以外的部分、root.tsx、关口、横幅 UpdateBanner、提醒 RemindHost 和它的按钮条、Suspense 占位、整屏提示）一个都不许有。
 * App.tsx 只许 ErrorView、FeatureOffView 两处（页面出错、功能关掉时顶替页面），下面单独数
 */
const PAGE_FILES = [
  ...PAGES_WITHOUT_FEATURE,
  'app/App.tsx',
  'features/auth/ui/AuthPage.tsx',
  'features/auth/ui/InstallGuide.tsx',
  'features/calendar/ui/CalendarPage.tsx',
  'features/onboarding/ui/ConsentPage.tsx',
  'features/settings/ui/SettingsPage.tsx',
  'features/today/ui/RecentlyDeletedPage.tsx',
  'features/today/ui/TodayPage.tsx',
  'features/todos/ui/TodosPage.tsx',
  'kit/components/Placeholder.tsx',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** 去掉注释（注释里提到 <main> 不算） */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
/** 一份源码里的 main：JSX 字面写的 <main …>，和 createElement('main' …)（React 的、document 的都算） */
function mainsIn(src: string): string[] {
  const s = stripComments(src);
  return [...s.matchAll(/<main\b[^>]*>/g), ...s.matchAll(/createElement\(\s*['"`]main['"`][^)]*\)?/g)].map((m) => m[0]);
}

describe('不带 data-feature 的 <main> 只在登记过的页面里', { timeout: 20_000 }, () => {
  it('src 里（.ts、.tsx，测试除外）找到的和登记的一致；createElement("main") 也算', () => {
    const found = new Set<string>();
    for (const f of walk(SRC)) {
      for (const m of mainsIn(readFileSync(f, 'utf8'))) {
        if (!/\bdata-feature=/.test(m)) found.add(relative(SRC, f).replaceAll('\\', '/'));
      }
    }
    expect([...found].sort()).toEqual([...PAGES_WITHOUT_FEATURE].sort());
  });

  it('外壳一个 main 都不许有（带 data-feature 的也不行）：main 只出现在页面文件里；App.tsx 只有 ErrorView、FeatureOffView 两处', () => {
    const outside: string[] = [];
    for (const f of walk(SRC)) {
      const r = relative(SRC, f).replaceAll('\\', '/');
      if (mainsIn(readFileSync(f, 'utf8')).length && !PAGE_FILES.includes(r)) outside.push(r);
    }
    expect(outside, '这些文件里有 main：是页面就登记进 PAGE_FILES，不是页面就别用 main（会提前触发首屏画完）').toEqual([]);
    expect(mainsIn(readFileSync(join(SRC, 'app/App.tsx'), 'utf8'))).toEqual(['<main data-feature="error">', '<main data-feature="off">']);
  });

  it('认法自检：JSX、createElement（单双引号、反引号）都认；注释里的不认', () => {
    expect(mainsIn("const a = <main data-feature=\"x\">;\ncreateElement('main', null);\ndocument.createElement(`main`);\n// <main>\n/* createElement('main') */")).toHaveLength(3);
  });
});
