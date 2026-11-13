// 皮肤与深浅色（ADR-008：两个独立维度，data-skin、data-theme 写在 <html> 上；需求 R-06、R-20、R-36、R-84、R-93、R-148）：settings 的四个键、
// 取值和默认值，写到 <html> 上，并在这台设备缓存一份（pv-look）。
// • 皮肤 ui.skin：'simple'（简洁，默认）| 'glass'（磨砂玻璃）；深浅色 ui.theme：'system'（跟着手机 / 电脑，默认）| 'light' | 'dark'；
//   ui.reduce_transparency → data-rt="1"、ui.reduce_motion → data-rm="1"，只有 true 才算开（系统设置另由 CSS 媒体查询和 motion/reduced.ts 照样跟随）
// • 按账号存（数据字典 settings 键清单；架构 5.9c 第 4 点“和皮肤 ui.skin、主题 ui.theme 一样按账号存”）
// • 跟随系统：按 prefers-color-scheme 算出 light / dark 写进 data-theme（皮肤变量只有 light、dark 两组，build/tokens.py 生成），系统切换时跟着改；
//   <meta name="color-scheme"> 跟着改，原生控件（日期、下拉）和页面一致
// • 主 App：main.tsx 入口一开始懒加载本模块（不进首屏，B4 首屏额度），一加载就按缓存套上，渲染之前等它，首屏不先闪一下默认皮肤；
//   coldStart 灌好集合以后 watchLook 盯住 settings（本页改、别的设备同步过来都重新套、更新缓存）。settings 集合是空的（新设备还没同步、
//   本机库不能用）不覆盖缓存那一份。登录页（src/auth/main.tsx）没有账号设置，只按缓存套
export const SKINS = ['simple', 'glass'] as const;
export type Skin = (typeof SKINS)[number];
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export interface Look {
  skin: Skin;
  theme: Theme;
  /** 减少透明效果（R-84） */
  rt: boolean;
  /** 减少动态效果（R-93） */
  rm: boolean;
}

export const LOOK_KEYS = { skin: 'ui.skin', theme: 'ui.theme', rt: 'ui.reduce_transparency', rm: 'ui.reduce_motion' } as const satisfies Record<keyof Look, string>;

/** 按键取值（settings 行、本机缓存都用它）；认不出的值按默认 */
export function lookOf(get: (k: keyof Look) => unknown): Look {
  const s = get('skin');
  const t = get('theme');
  return {
    skin: s === 'glass' ? 'glass' : 'simple',
    theme: t === 'light' || t === 'dark' ? t : 'system',
    rt: get('rt') === true,
    rm: get('rm') === true,
  };
}

/** settings 行里四个键现在生效的值（同 core/setting-read.ts 的 settingValue；platform 不能引 core）。
 *  生效 = 没删、没撤销，判断同 shared/logic/live-row.ts 的 isLiveRow；这里抄一行不引它：引了以后入口懒加载本模块要多带一个分包，首屏多十几字节（B4 额度） */
export interface LookRow {
  readonly key?: unknown;
  readonly value?: unknown;
  readonly deleted_at?: unknown;
  readonly undone?: unknown;
}
export const lookOfRows = (rows: readonly LookRow[]): Look => lookOf((k) => rows.find((r) => r.key === LOOK_KEYS[k] && r.deleted_at == null && r.undone !== true)?.value);

const CACHE_KEY = 'pv-look';
let current: Look | null = null;
let dark: MediaQueryList | null = null;

function paint(): void {
  if (!current) return;
  const r = document.documentElement;
  const theme = current.theme === 'system' ? (dark?.matches ? 'dark' : 'light') : current.theme;
  r.dataset['skin'] = current.skin;
  r.dataset['theme'] = theme;
  if (current.rt) r.dataset['rt'] = '1';
  else delete r.dataset['rt'];
  if (current.rm) r.dataset['rm'] = '1';
  else delete r.dataset['rm'];
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
}

/** 套上并记进本机缓存；同样的值再套一次不重画 */
export function applyLook(look: Look): void {
  if (!dark && typeof matchMedia === 'function') {
    dark = matchMedia('(prefers-color-scheme: dark)');
    dark.addEventListener('change', paint);
  }
  const same = current !== null && JSON.stringify(current) === JSON.stringify(look);
  current = look;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(look));
  } catch {
    // 写不进（隐私模式、配额满）：这次照样生效，只是下次启动先按默认
  }
  if (!same) paint();
}

/** 本机缓存的那一份（没有、坏了按默认：简洁、跟随系统、两个开关关） */
export function cachedLook(): Look {
  let o: Partial<Record<keyof Look, unknown>> = {};
  try {
    const v: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
    if (v && typeof v === 'object') o = v;
  } catch {
    // 读不到、不是 JSON：按默认
  }
  return lookOf((k) => o[k]);
}

/** 盯住 settings 集合（main.tsx 传 core/store 的 collection('settings')）；返回取消函数 */
export function watchLook(c: { getSnapshot(): readonly LookRow[]; subscribe(l: () => void): () => void }): () => void {
  const run = (): void => {
    const rows = c.getSnapshot();
    if (rows.length) applyLook(lookOfRows(rows));
  };
  run();
  return c.subscribe(run);
}

// 主 App 懒加载本模块的那一刻就按缓存套上（登录页同样静态引入后马上套）
applyLook(cachedLook());
