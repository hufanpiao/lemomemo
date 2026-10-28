// TC-B0-10（架构 17.2 第 6 点、R-155；QA D-06）：单个动效 ≤ 400ms，只有底栏液滴 --dur-drop（0.55s）例外。
// 扫 src 下所有 CSS（含生成的 tokens.css、skins/*.css）里的时长令牌和 transition / animation，再看 src/motion/tokens.ts 的 dur；
// 违规样例 tests/arch-fixtures/durations/tc-b0-10-500ms.css 证明 500ms 会被报出
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dur } from '../../src/motion/tokens.ts';
import { FIXTURES, ROOT } from './fixture-header.ts';

/** 上限（毫秒）和唯一的例外 */
const MAX_MS = 400;
const EXCEPTIONS = new Set(['--dur-drop']);

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

describe('TC-B0-10：单个动效 ≤ 400ms，只有 --dur-drop 例外', () => {
  it('src 下所有 CSS：超过 400ms 的只有 --dur-drop', () => {
    const files = cssFiles(join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(3);
    const hits = files.flatMap((f) => longDurations(readFileSync(f, 'utf8'), relative(ROOT, f).replaceAll('\\', '/')));
    expect(hits.filter((h) => !EXCEPTIONS.has(h.prop))).toEqual([]);
    // 例外确实在（0.55s），而且只在生成的 tokens.css 里定义
    expect(hits.map((h) => `${h.file} ${h.prop} ${h.ms}`)).toEqual(['src/styles/tokens.css --dur-drop 550']);
  });

  it('src/motion/tokens.ts 的 dur：超过 0.4 秒的只有 drop', () => {
    const long = Object.entries(dur)
      .filter(([, s]) => s * 1000 > MAX_MS)
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
