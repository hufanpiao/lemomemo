// 底栏锁定测试（定稿部件，docs/00-团队/界面改动防返工规则.md 第四条；R-360、R-361）。
// 唯一参照：docs/03-评审/B2/底栏透明度截图/底栏-11-07还原后-对照确认图.png 的右列，代码是 e96d8e2 的底栏（负责人 11-07“可以，就这样”，R-361）。
// 这里把关键数值（模糊、着色、实色起点、渐变宽度）按源码文字写死，改任何一个都会失败。
// 要改：必须先有负责人新定的需求编号，在下面 LOCK 旁边写上编号再改值；Chromium 视觉锁定（tests/e2e/visual/tabbar-lock.spec.ts）的基准图同时重拍。
// jsdom 不算样式，按源码文字核对（同 src/app/__tests__/safe-top-css.test.ts 的做法）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WHY = '改底栏要负责人新需求编号（R-360、R-361）；参照图 docs/03-评审/B2/底栏透明度截图/底栏-11-07还原后-对照确认图.png 右列';

const read = (p: string): string => readFileSync(p, 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
const norm = (s: string): string => s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

/** 取某条规则（选择器按文字精确匹配，多个选择器间的换行、空格忽略）的声明表 */
function declsOf(css: string, selector: string): Record<string, string> | null {
  const src = stripComments(css);
  const want = norm(selector.replace(/\s*,\s*/g, ','));
  // 逐条找 “选择器 {”：选择器是上一个 } 或 { 或文件头之后、这个 { 之前的文字
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const sel = norm((m[1] ?? '').replace(/\s*,\s*/g, ','));
    if (sel !== want) continue;
    const out: Record<string, string> = {};
    for (const d of (m[2] ?? '').split(/;(?![^(]*\))/)) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      const k = d.slice(0, i).trim();
      if (k) out[k] = norm(d.slice(i + 1));
    }
    return out;
  }
  return null;
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return cssFiles(p);
    return p.endsWith('.css') ? [p] : [];
  });
}

const SKINS = {
  'src/styles/skins/simple.css': ['simple'],
  'src/styles/skins/glass.css': ['glass'],
} as const;
const THEMES = ['light', 'dark'] as const;
const TOKENS = ['--g-live-fx', '--g-tint', '--g-tint-fb', '--g-fab-tint'] as const;

/** 锁定值（e96d8e2，R-361）。改任何一项都要带负责人新需求编号 */
const LOCK = {
  tokens: {
    'simple-light': { '--g-live-fx': 'blur(3px) saturate(1.8) brightness(1.04)', '--g-tint': 'rgba(255,255,255,.12)', '--g-tint-fb': 'rgba(255,255,255,.62)', '--g-fab-tint': 'rgba(242,223,74,.72)' },
    'simple-dark': { '--g-live-fx': 'blur(3px) saturate(1.8) brightness(1.04)', '--g-tint': 'rgba(30,31,36,.44)', '--g-tint-fb': 'rgba(30,31,36,.72)', '--g-fab-tint': 'rgba(242,223,74,.86)' },
    'glass-light': { '--g-live-fx': 'blur(3px) saturate(1.8) brightness(1.04)', '--g-tint': 'rgba(255,255,255,.12)', '--g-tint-fb': 'rgba(255,255,255,.62)', '--g-fab-tint': 'rgba(242,223,74,.72)' },
    'glass-dark': { '--g-live-fx': 'blur(3px) saturate(1.8) brightness(1.04)', '--g-tint': 'rgba(30,31,36,.44)', '--g-tint-fb': 'rgba(30,31,36,.72)', '--g-fab-tint': 'rgba(242,223,74,.86)' },
  },
  /** .bar、.fab 的模糊：首屏后备 8px，副本引擎接管后（data-glass="copy"，实际看到的样子）用 --g-live-fx */
  barFallback: 'blur(8px) saturate(1.8)',
  barLive: 'var(--g-live-fx)',
  /** 实色带：从底栏底边（离屏幕底 8px）起是实色，往上 --band-fade 从 --bg 渐到透明 */
  bandHeight: 'calc(8px + var(--band-fade) + var(--inset-bottom))',
  bandBackground: 'linear-gradient(to bottom, transparent 0, var(--bg) var(--band-fade), var(--bg) 100%)',
  bandFade: '24px',
  /** 上沿外渐隐：底栏上沿往上 --edge-fade（12px）从 0 渐到满，3px 模糊、叠一半 --bg */
  edgeFade: '12px',
  edgeBlur: 'blur(3px)',
  edgeMaskImage:
    'linear-gradient(to bottom, transparent 0, var(--bg) var(--edge-fade)), radial-gradient(circle at var(--edge-fab-x) var(--edge-cy), var(--bg) var(--edge-fab-in), transparent var(--edge-fab-out)), radial-gradient(circle at calc(var(--edge-bar-l) + 31px) var(--edge-cy), var(--bg) 30.5px, transparent 31px), radial-gradient(circle at calc(var(--edge-bar-r) - 31px) var(--edge-cy), var(--bg) 30.5px, transparent 31px), linear-gradient(var(--bg), var(--bg))',
  edgeTintOpacity: '0.5',
} as const;

const glassBar = read('src/kit/components/GlassBar/GlassBar.module.css');
const glassFx = read('src/kit/components/GlassBar/GlassBarFx.module.css');
const base = read('src/styles/base.css');

/** 读出当前源码里的全部锁定项（和 LOCK 同形状），供比对和下面的“改一个就挂”自检 */
function current(src: { skins: Record<string, string>; glassBar: string; glassFx: string; base: string }) {
  const tokens: Record<string, Record<string, string | undefined>> = {};
  for (const [file, [skin]] of Object.entries(SKINS)) {
    for (const theme of THEMES) {
      const d = declsOf(src.skins[file] ?? '', `:root[data-skin="${skin}"][data-theme="${theme}"]`) ?? {};
      tokens[`${skin}-${theme}`] = Object.fromEntries(TOKENS.map((k) => [k, d[k]]));
    }
  }
  const varIn = (css: string, name: string): string | undefined => new RegExp(`${name}:\\s*([^;]+);`).exec(stripComments(css))?.[1]?.trim();
  return {
    tokens,
    barFallback: declsOf(src.glassBar, '.bar, .fab')?.['backdrop-filter'],
    barLive: declsOf(src.glassBar, ".bar[data-glass='copy'], .fab[data-glass='copy']")?.['backdrop-filter'],
    bandHeight: declsOf(src.glassFx, '.band')?.['height'],
    bandBackground: declsOf(src.glassFx, '.band')?.['background'],
    bandFade: varIn(src.base, '--band-fade'),
    edgeFade: varIn(src.base, '--edge-fade'),
    edgeBlur: declsOf(src.glassFx, '.edge')?.['backdrop-filter'],
    edgeMaskImage: declsOf(src.glassFx, '.edge')?.['mask-image'],
    edgeTintOpacity: declsOf(src.glassFx, '.edgeTint')?.['opacity'],
  };
}

const SRC = {
  skins: Object.fromEntries(Object.keys(SKINS).map((f) => [f, read(f)])),
  glassBar,
  glassFx,
  base,
};

describe('底栏锁定（R-360、R-361，参照 11-07 对照确认图右列）', () => {
  const now = current(SRC);

  it('四套皮肤的玻璃令牌 --g-live-fx、--g-tint、--g-tint-fb、--g-fab-tint', () => {
    expect(now.tokens, WHY).toEqual(LOCK.tokens);
  });

  it('.bar、.fab 的 backdrop-filter（后备 8px、接管后 --g-live-fx）', () => {
    expect({ barFallback: now.barFallback, barLive: now.barLive }, WHY).toEqual({ barFallback: LOCK.barFallback, barLive: LOCK.barLive });
  });

  it('.band 实色起点 8px 和 --band-fade', () => {
    expect({ bandHeight: now.bandHeight, bandBackground: now.bandBackground, bandFade: now.bandFade }, WHY).toEqual({
      bandHeight: LOCK.bandHeight,
      bandBackground: LOCK.bandBackground,
      bandFade: LOCK.bandFade,
    });
  });

  it('.edge 的 --edge-fade 12px、遮罩渐变、3px 模糊和一半 --bg 着色', () => {
    expect({ edgeFade: now.edgeFade, edgeBlur: now.edgeBlur, edgeMaskImage: now.edgeMaskImage, edgeTintOpacity: now.edgeTintOpacity }, WHY).toEqual({
      edgeFade: LOCK.edgeFade,
      edgeBlur: LOCK.edgeBlur,
      edgeMaskImage: LOCK.edgeMaskImage,
      edgeTintOpacity: LOCK.edgeTintOpacity,
    });
  });

  it('这些令牌和变量只在原处定义，别处不许另写一份盖掉', () => {
    const owner: Record<string, string[]> = {
      '--g-live-fx': Object.keys(SKINS),
      '--g-tint': Object.keys(SKINS),
      '--g-tint-fb': Object.keys(SKINS),
      '--g-fab-tint': Object.keys(SKINS),
      '--band-fade': ['src/styles/base.css'],
      '--edge-fade': ['src/styles/base.css'],
    };
    for (const f of cssFiles('src')) {
      const rel = f.replaceAll('\\', '/');
      const css = stripComments(read(f));
      for (const [name, files] of Object.entries(owner)) {
        if (files.includes(rel)) continue;
        expect(new RegExp(`${name}\\s*:`).test(css), `${rel} 另外定义了 ${name}。${WHY}`).toBe(false);
      }
    }
  });

  it('自检：随便改一个锁定值，比对一定失败（防止解析失灵、锁形同虚设）', () => {
    const mutations: [string, (s: typeof SRC) => typeof SRC][] = [
      ['--g-tint 浅色 .12→.2', (s) => ({ ...s, skins: { ...s.skins, 'src/styles/skins/glass.css': (s.skins['src/styles/skins/glass.css'] ?? '').replace('--g-tint:rgba(255,255,255,.12)', '--g-tint:rgba(255,255,255,.2)') } })],
      ['--g-live-fx 3px→8px', (s) => ({ ...s, skins: { ...s.skins, 'src/styles/skins/simple.css': (s.skins['src/styles/skins/simple.css'] ?? '').replace('--g-live-fx:blur(3px)', '--g-live-fx:blur(8px)') } })],
      ['.bar 后备 8px→12px', (s) => ({ ...s, glassBar: s.glassBar.replace('backdrop-filter: blur(8px) saturate(1.8);', 'backdrop-filter: blur(12px) saturate(1.8);') })],
      ['.band 实色起点 8px→6px', (s) => ({ ...s, glassFx: s.glassFx.replace('height: calc(8px + var(--band-fade)', 'height: calc(6px + var(--band-fade)') })],
      ['--band-fade 24px→54px', (s) => ({ ...s, base: s.base.replace('--band-fade: 24px;', '--band-fade: 54px;') })],
      ['--edge-fade 12px→24px', (s) => ({ ...s, base: s.base.replace('--edge-fade: 12px;', '--edge-fade: 24px;') })],
      ['.edge 遮罩第一段渐变改起点', (s) => ({ ...s, glassFx: s.glassFx.replace('linear-gradient(to bottom, transparent 0, var(--bg) var(--edge-fade))', 'linear-gradient(to bottom, transparent 4px, var(--bg) var(--edge-fade))') })],
    ];
    const lockNow = JSON.stringify(current(SRC));
    expect(lockNow).toBe(JSON.stringify({ tokens: LOCK.tokens, barFallback: LOCK.barFallback, barLive: LOCK.barLive, bandHeight: LOCK.bandHeight, bandBackground: LOCK.bandBackground, bandFade: LOCK.bandFade, edgeFade: LOCK.edgeFade, edgeBlur: LOCK.edgeBlur, edgeMaskImage: LOCK.edgeMaskImage, edgeTintOpacity: LOCK.edgeTintOpacity }));
    for (const [name, mut] of mutations) {
      const after = mut(SRC);
      expect(JSON.stringify(after) !== JSON.stringify(SRC), `自检“${name}”没改到源码文字，替换串过期了`).toBe(true);
      expect(JSON.stringify(current(after)), `改了“${name}”锁却没发现`).not.toBe(lockNow);
    }
  });
});
