// 皮肤与深浅色（ADR-008：两个独立维度，data-skin、data-theme 写在 <html> 上）：settings 的键、取值和默认值，套到 <html> 上，本机缓存一份（pv-look）。
// • 皮肤 ui.skin：'glass'（默认）| 'simple'；深浅色 ui.theme：'system'（默认）| 'light' | 'dark'；都按账号存
// • 减少透明、减少动态只在这一处判断：data-rt="1" 只表示系统设了 prefers-reduced-transparency: reduce（页面要求实色另写 data-solid="1"，
//   见 holdReducedTransparency），data-rm 同理看 prefers-reduced-motion。旧账号存过的 ui.reduce_transparency、ui.reduce_motion 不再读
//   CSS 只认 :root[data-rt='1']（要实色写 :root:is([data-rt='1'], [data-solid='1'])）、:root[data-rm='1']，motion/reduced.ts、glass-ghost.ts 只看属性；
//   只有 splash.css 自己看媒体查询（它要在本模块加载前生效）。tests/arch/no-reduced-media.test.ts 守着
// • 跟随系统：按 prefers-color-scheme 算出 light / dark 写进 data-theme（皮肤变量只有这两组，build/tokens.py 生成）；原生控件 color-scheme 由 base.css 跟着改
// • 主 App 入口懒加载本模块（不进首屏），一加载就按缓存套上；渲染前最多等 600 毫秒（app/look-wait.ts），晚到照样套。watchLook 盯住 settings 并更新缓存；
//   settings 为空不覆盖缓存；退出、换账号清本机数据（core/account.ts）连缓存一起删。登录页（src/auth/main.tsx）只按缓存套
// • 字体 ui.font（值 {v: 1, id}，缓存只记 id）：不是系统字体才懒加载 platform/fonts.ts，换回系统字体同样交给它；认不出的 id 按系统字体；分包下载不了下次再套时重试
// • 运行日志（main.tsx 经 watchLook 注入 logEvent）：皮肤、深浅色、减少效果变了记 look_apply，字体记 font_load。不记用户输入的文字
import { LOOK_CACHE_KEY } from './exit-basics.ts';

/** 设置 › 皮肤里的先后顺序：默认的磨砂玻璃放第一个 */
export const SKINS = ['glass', 'simple'] as const;
export type Skin = (typeof SKINS)[number];
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export interface Look {
  skin: Skin;
  theme: Theme;
  /** 字体 id（'system' 系统字体，默认） */
  font: string;
}

export const LOOK_KEYS = { skin: 'ui.skin', theme: 'ui.theme', font: 'ui.font' } as const satisfies Record<keyof Look, string>;

/** 运行日志（同 shared/core/log-bus.ts 的 logEvent；platform 不碰日志层，由 main.tsx 注入） */
export type LookLog = (act: string, f: { code?: string; itemId?: string }) => void;

/** 写进 settings 的值：ui.font 存 {v: 1, id}，其余直接存 */
export const lookValue = <K extends keyof Look>(k: K, v: Look[K]): unknown => (k === 'font' ? { v: 1, id: v } : v);

/** 按键取值（settings 行、本机缓存都用它）；认不出的值按默认 */
export function lookOf(get: (k: keyof Look) => unknown): Look {
  const s = get('skin');
  const t = get('theme');
  const f = get('font');
  const id = f !== null && typeof f === 'object' ? (f as { id?: unknown }).id : f;
  return {
    // 只有明确选过简洁的才是简洁，其余按默认磨砂玻璃
    skin: s === 'simple' ? 'simple' : 'glass',
    theme: t === 'light' || t === 'dark' ? t : 'system',
    font: typeof id === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(id) ? id : 'system',
  };
}

/** settings 的一行（只用到这几列） */
export interface LookRow {
  readonly key?: unknown;
  readonly value?: unknown;
  readonly deleted_at?: unknown;
  readonly undone?: unknown;
}
/**
 * settings 行里这个键现在生效的值（没有、被删、被撤销都是 undefined）：platform 和懒加载功能块（feedback.ts、mascot）都用这一份。
 * core 那边是 core/setting-read.ts 的 settingValue，同一个判断（shared/logic/live-row.ts 的 isLiveRow）。
 * 不引 live-row：它在非首屏的 lazy-data 块里，渲染前要等的本模块会多带一个分包
 */
export const liveSetting = (rows: readonly LookRow[], key: string): unknown => rows.find((r) => r.key === key && r.deleted_at == null && r.undone !== true)?.value;
export const lookOfRows = (rows: readonly LookRow[]): Look => lookOf((k) => liveSetting(rows, LOOK_KEYS[k]));

let current: Look | null = null;
let log: LookLog | null = null;
let painted = '';
let font = 'system';
const sys: Record<'dark' | 'rt' | 'rm', MediaQueryList | null> = { dark: null, rt: null, rm: null };

/** 页面要求强制实色（隐私记页挂着时）：计数，> 0 时 data-solid 是 1 */
let solidHolds = 0;

const flag = (r: HTMLElement, k: 'rt' | 'rm' | 'solid', on: boolean): void => {
  if (on) r.dataset[k] = '1';
  else delete r.dataset[k];
};

/**
 * 隐私记页挂着时底栏和“＋”用实色、不建液态玻璃副本。写 data-solid（不碰 data-rt：它只表示系统设置）；
 * 底栏、“＋”、玻璃副本认 data-rt 或 data-solid 任一个，输入时的模糊层（kit Mist）只认 data-rt（和随手记一样）。
 * 走 paint，重画时不会被冲掉；返回的函数放开（多次调用只算一次）
 */
export function holdReducedTransparency(): () => void {
  solidHolds += 1;
  paint();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    solidHolds -= 1;
    paint();
  };
}

const SYS_SETTLE_MS = 300;
let sysTimer: ReturnType<typeof setTimeout> | undefined;

function paint(): void {
  const r = document.documentElement;
  const rt = sys.rt?.matches === true;
  const rm = sys.rm?.matches === true;
  flag(r, 'rt', rt);
  flag(r, 'solid', solidHolds > 0);
  flag(r, 'rm', rm);
  if (!current) return;
  const theme = current.theme === 'system' ? (sys.dark?.matches ? 'dark' : 'light') : current.theme;
  r.dataset['skin'] = current.skin;
  r.dataset['theme'] = theme;
  const desc = `skin=${current.skin} theme=${current.theme}>${theme} rt=${solidHolds > 0 ? 'hold' : rt ? 'sys' : 'off'} rm=${rm ? 'sys' : 'off'}`;
  if (desc !== painted) log?.('look_apply', { code: desc });
  painted = desc;
  if (current.font !== font) {
    const prev = font;
    const id = (font = current.font);
    import('./fonts.ts').then(
      // 日志按调用时的 log 取：冷启动按缓存套字体时日志还没注入，等下完、确认时已经注入了
      (m) => m.applyFont(id, (a, f) => log?.(a, f)),
      () => {
        // 分包下载不了：退回原值，下次再套时重试
        if (font === id) font = prev;
        log?.('font_load', { itemId: id, code: 'fail font_chunk' });
      },
    );
  }
}

/** 套上并记进本机缓存；同样的值再套一次不重画 */
export function applyLook(look: Look): void {
  if (!sys.dark && typeof matchMedia === 'function') {
    sys.dark = matchMedia('(prefers-color-scheme: dark)');
    sys.rt = matchMedia('(prefers-reduced-transparency: reduce)');
    sys.rm = matchMedia('(prefers-reduced-motion: reduce)');
    sys.rt.addEventListener('change', paint);
    sys.rm.addEventListener('change', paint);
    // 系统深浅色变了不当场换肤：iOS 切到后台时会临时翻一下深浅色给切换器拍照、回前台再翻回来，当场换会切回来时白屏。
    // 等 SYS_SETTLE_MS、页面还在前台才画；在后台不画，回前台时再看一次真实的值
    const settle = (): void => {
      clearTimeout(sysTimer);
      sysTimer = setTimeout(() => {
        if (document.visibilityState === 'visible') paint();
      }, SYS_SETTLE_MS);
    };
    sys.dark.addEventListener('change', settle);
    document.addEventListener('visibilitychange', settle);
  }
  const same = current !== null && JSON.stringify(current) === JSON.stringify(look);
  current = look;
  try {
    localStorage.setItem(LOOK_CACHE_KEY, JSON.stringify({ ...look, v: 2 }));
  } catch {
    // 写不进（隐私模式、配额满）：这次照样生效，只是下次启动先按默认
  }
  if (!same) paint();
}

/** 本机缓存的那一份（没有、坏了按默认：磨砂玻璃、跟随系统、系统字体） */
export function cachedLook(): Look {
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LOOK_CACHE_KEY) ?? '{}');
    if (v && typeof v === 'object') o = v as Record<string, unknown>;
  } catch {
    // 读不到、不是 JSON：按默认
  }
  // 没有 v: 2 的旧缓存里的“简洁”多半只是旧默认：不认，先按磨砂玻璃画；真选过简洁的，设置一灌进来就换回
  if (o['v'] !== 2 && o['skin'] === 'simple') delete o['skin'];
  return lookOf((k) => o[k]);
}

/** 盯住 settings 集合（main.tsx 传 core/store 的 collection('settings') 和 logEvent）；返回取消函数 */
export function watchLook(c: { getSnapshot(): readonly LookRow[]; subscribe(l: () => void): () => void }, l: LookLog | null = null): () => void {
  log = l;
  // 缓存那一份在注入日志之前就套上了：这里补记一条
  log?.('look_apply', { code: `cache ${painted}` });
  const run = (): void => {
    const rows = c.getSnapshot();
    if (rows.length) applyLook(lookOfRows(rows));
  };
  run();
  return c.subscribe(run);
}

// 主 App 懒加载本模块的那一刻就按缓存套上（登录页同样静态引入后马上套）
applyLook(cachedLook());
// 换回系统字体后还有没清的字体缓存（fonts.ts 的 pv-font-gc）：交给 fonts.ts 到点清掉
try {
  if (font === 'system' && /"at":[1-9]/.test(localStorage.getItem('pv-font-gc') ?? '')) void import('./fonts.ts').then((m) => m.applyFont('system'), () => undefined);
} catch {
  // 读不到本机存储：不清
}
