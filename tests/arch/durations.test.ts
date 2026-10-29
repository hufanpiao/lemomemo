// TC-B0-10（架构 17.2 第 6 点、R-155；QA D-06）：单个动效 ≤ 400ms，只有底栏液滴 --dur-drop（0.55s）例外。
// 10-29 加第二组例外：启动画面专用的 --dur-splash-*（R-254 负责人选定的方向 B 时间线：0.8 秒静止、1.6 秒一轮起伏、0.6 秒变暗、
// 6 秒兜底；still / bar2 / bar3 / failsafe 是开始时刻，不是时长），只准在生成的 tokens.css 里定义、只在 src/styles/splash.css 里用
// 扫 src 下所有 CSS（含生成的 tokens.css、skins/*.css）里的时长令牌和 transition / animation，再看 src/motion/tokens.ts 的 dur；
// 违规样例 tests/arch-fixtures/durations/tc-b0-10-500ms.css 证明 500ms 会被报出
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dur } from '../../src/motion/tokens.ts';
import { FIXTURES, ROOT } from './fixture-header.ts';

/** 上限（毫秒）和唯一的例外 */
const MAX_MS = 400;
const SPLASH = ['still', 'bar2', 'bar3', 'breathe', 'dark', 'failsafe'].map((k) => `--dur-splash-${k}`);
const EXCEPTIONS = new Set(['--dur-drop', ...SPLASH]);
/** 启动画面令牌在 src/motion/tokens.ts 里的键 */
const SPLASH_TS = new Set(['splashStill', 'splashBar2', 'splashBar3', 'splashBreathe', 'splashDark', 'splashFailsafe']);
/** 启动画面令牌（--dur-splash-*、--ease-splash-*，TS 里的 dur.splash*、ease.splashBreathe）只准出现在这几个文件 */
const SPLASH_ALLOWED = new Set(['src/styles/tokens.css', 'src/styles/splash.css', 'src/motion/tokens.ts']);
const SPLASH_USE = /--(?:dur|ease)-splash-|\bsplash(?:Still|Bar2|Bar3|Breathe|Dark|OutRm|Failsafe)\b/g;

/** 一段源码里用到的启动画面令牌（CSS 变量名前缀或 TS 键名），按出现顺序 */
export function splashTokenUses(text: string): string[] {
  return [...text.matchAll(SPLASH_USE)].map((m) => m[0]);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'public' ? [] : sourceFiles(p);
    return /\.(css|ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

interface Hit {
  file: string;
  prop: string;
  ms: number;
}

const DECL = /([\w-]+)\s*:\s*([^;{}]+)/g;
const TIME = /(?<![\w.-])(\d*\.?\d+)(ms|s)(?![\w-])/g;
const TIMED_PROP = /^(--dur-[\w-]+|transition|transition-duration|animation|animation-duration)$/;

/** 一段 CSS 里超过上限的时长（例外也列出来，由调用方判断） */
export function longDurations(css: string, file: string): Hit[] {
  const hits: Hit[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const d of text.matchAll(DECL)) {
    const prop = d[1] ?? '';
    if (!TIMED_PROP.test(prop)) continue;
    for (const t of (d[2] ?? '').matchAll(TIME)) {
      const ms = Number(t[1]) * (t[2] === 's' ? 1000 : 1);
      if (ms > MAX_MS) hits.push({ file, prop, ms });
    }
  }
  return hits;
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'public' ? [] : cssFiles(p);
    return e.name.endsWith('.css') ? [p] : [];
  });
}

describe('TC-B0-10：单个动效 ≤ 400ms，例外只有 --dur-drop 和启动画面的 --dur-splash-*（R-254，只限 splash.css）', () => {
  it('src 下所有 CSS：超过 400ms 的只有 --dur-drop 和 --dur-splash-*', () => {
    const files = cssFiles(join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(3);
    const hits = files.flatMap((f) => longDurations(readFileSync(f, 'utf8'), relative(ROOT, f).replaceAll('\\', '/')));
    expect(hits.filter((h) => !EXCEPTIONS.has(h.prop))).toEqual([]);
    // 例外确实在（0.55s 和启动画面那几个），而且只在生成的 tokens.css 里定义
    expect(hits.map((h) => `${h.file} ${h.prop} ${h.ms}`)).toEqual([
      'src/styles/tokens.css --dur-drop 550',
      'src/styles/tokens.css --dur-splash-still 800',
      'src/styles/tokens.css --dur-splash-bar2 1000',
      'src/styles/tokens.css --dur-splash-bar3 1200',
      'src/styles/tokens.css --dur-splash-breathe 1600',
      'src/styles/tokens.css --dur-splash-dark 600',
      'src/styles/tokens.css --dur-splash-failsafe 6000',
    ]);
  });

  it('启动画面的令牌只在 src/styles/splash.css 里用（扫 src 的 css、ts、tsx；令牌的定义文件和测试除外）', () => {
    const hits = sourceFiles(join(ROOT, 'src'))
      .map((f) => relative(ROOT, f).replaceAll('\\', '/'))
      .filter((rel) => !SPLASH_ALLOWED.has(rel) && !/(^|\/)__tests__\//.test(rel))
      .flatMap((rel) => splashTokenUses(readFileSync(join(ROOT, rel), 'utf8')).map((m) => `${rel}: ${m}`));
    expect(hits).toEqual([]);
  });

  it('启动画面令牌的检查拦得住：var() 里带空格、--ease-splash-*、TS 里的 dur.splash* / ease.splashBreathe、字符串里的 var()', () => {
    expect(splashTokenUses('.a{animation: x var( --dur-splash-breathe) 1}')).toEqual(['--dur-splash-']);
    expect(splashTokenUses('.a{animation-timing-function: var(--ease-splash-breathe)}')).toEqual(['--ease-splash-']);
    expect(splashTokenUses('animate(el, {}, { duration: dur.splashBreathe })')).toEqual(['splashBreathe']);
    expect(splashTokenUses('const t = ease.splashBreathe;')).toEqual(['splashBreathe']);
    expect(splashTokenUses("el.style.transition = 'opacity var(--dur-splash-failsafe)';")).toEqual(['--dur-splash-']);
    expect(splashTokenUses('const { splashStill, splashOutRm } = dur;')).toEqual(['splashStill', 'splashOutRm']);
    expect(splashTokenUses('.a{transition: opacity var(--dur-ui) var(--ease-out)} hideSplash(); SPLASH_FADE_RM_MS')).toEqual([]);
  });

  it('src/motion/tokens.ts 的 dur：超过 0.4 秒的只有 drop（和启动画面那几个）', () => {
    const long = Object.entries(dur)
      .filter(([k, s]) => s * 1000 > MAX_MS && !SPLASH_TS.has(k))
      .map(([k]) => k);
    expect(long).toEqual(['drop']);
  });

  it('违规样例：加一个 500ms 的令牌和一条 0.5s 的 transition → 两处都报', () => {
    const file = join(FIXTURES, 'durations', 'tc-b0-10-500ms.css');
    const hits = longDurations(readFileSync(file, 'utf8'), 'fixture');
    expect(hits.map((h) => `${h.prop} ${h.ms}`)).toEqual(['--dur-slow 500', 'transition 500']);
  });

  it('边界：正好 400ms 不报、401ms 报；注释里的时长不算', () => {
    expect(longDurations('.a{transition: opacity 400ms}', 'x')).toEqual([]);
    expect(longDurations('.a{animation-duration: 401ms}', 'x')).toHaveLength(1);
    expect(longDurations('/* --dur-x: 900ms */ .a{color: red}', 'x')).toEqual([]);
  });
});
