// 皮肤与深浅色（ADR-008：两个独立维度，data-skin、data-theme 写在 <html> 上；需求 R-06、R-20、R-36、R-84、R-93、R-148）：settings 的键、
// 取值和默认值，写到 <html> 上，并在这台设备缓存一份（pv-look）。
// • 皮肤 ui.skin：'simple'（简洁，默认）| 'glass'（磨砂玻璃）；深浅色 ui.theme：'system'（跟着手机 / 电脑，默认）| 'light' | 'dark'
// • 减少透明效果、减少动态效果只有这一处判断（皮肤整块评审第 1、6 条）：data-rt="1" = 系统设置了 prefers-reduced-transparency: reduce
//   （或隐私记页要求实色），data-rm 同理看 prefers-reduced-motion。系统设置变了跟着改。设置里原来的两个开关（R-84、R-93）
//   11-14 负责人要求去掉（“设置里面减少透明效果跟减少动态效果都去掉，不要这个功能”），旧账号存过的 ui.reduce_transparency、ui.reduce_motion 不再读
//   CSS 只认 :root[data-rt='1']、:root[data-rm='1']，motion/reduced.ts、glass-ghost.ts 只看属性；全仓库只有启动画面 splash.css 自己看媒体查询
//   （它要在本模块加载前生效）。tests/arch/no-reduced-media.test.ts 守着
// • 按账号存（数据字典 settings 键清单；架构 5.9c 第 4 点“和皮肤 ui.skin、主题 ui.theme 一样按账号存”）
// • 跟随系统：按 prefers-color-scheme 算出 light / dark 写进 data-theme（皮肤变量只有 light、dark 两组，build/tokens.py 生成），系统切换时跟着改；
//   原生控件的 color-scheme 由 base.css 的 :root[data-theme] 两条规则跟着改
// • 主 App：main.tsx 入口一开始懒加载本模块（不进首屏），一加载就按缓存套上；渲染前最多等它 600 毫秒（app/look-wait.ts），
//   晚到照样套上。coldStart 灌好集合以后 watchLook 盯住 settings（本页改、别的设备同步过来都重新套、更新缓存）。settings 集合是空的
//   （新设备还没同步、本机库不能用）不覆盖缓存那一份；退出、换账号时清本机数据（core/account.ts）连缓存一起删，下一个账号从默认开始。
//   登录页（src/auth/main.tsx）没有账号设置，只按缓存套
// • 字体 ui.font（架构 5.9c，值 {v: 1, id}，缓存里只记 id；编码 lookValue、解码 lookOf 挨着）：不是系统字体时才懒加载 platform/fonts.ts
//   去下载、套上（首屏不带），换回系统字体时同样交给它拿掉；认不出的 id 按系统字体。分包下载不了：记下失败、下次再套时重试
// • 运行日志（main.tsx 经 watchLook 注入 logEvent，同 push-disconnect.ts）：皮肤、深浅色、两个减少效果（系统设置）变了记 look_apply；字体记 font_load。不记用户输入的文字
import { LOOK_CACHE_KEY } from './exit-basics.ts';

export const SKINS = ['simple', 'glass'] as const;
export type Skin = (typeof SKINS)[number];
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export interface Look {
  skin: Skin;
  theme: Theme;
  /** 字体 id（'system' 系统字体，默认；架构 5.9c） */
  font: string;
}

export const LOOK_KEYS = { skin: 'ui.skin', theme: 'ui.theme', font: 'ui.font' } as const satisfies Record<keyof Look, string>;

/** 运行日志（同 shared/core/log-bus.ts 的 logEvent；platform 不碰日志层，由 main.tsx 注入） */
export type LookLog = (act: string, f: { code?: string; itemId?: string }) => void;

/** 写进 settings 的值：ui.font 存 {v: 1, id}（架构 5.9c 第 4 点），其余直接存 */
export const lookValue = <K extends keyof Look>(k: K, v: Look[K]): unknown => (k === 'font' ? { v: 1, id: v } : v);

/** 按键取值（settings 行、本机缓存都用它）；认不出的值按默认 */
export function lookOf(get: (k: keyof Look) => unknown): Look {
  const s = get('skin');
  const t = get('theme');
  const f = get('font');
  const id = f !== null && typeof f === 'object' ? (f as { id?: unknown }).id : f;
  return {
    skin: s === 'glass' ? 'glass' : 'simple',
    theme: t === 'light' || t === 'dark' ? t : 'system',
    font: typeof id === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(id) ? id : 'system',
  };
}

/** settings 行里各键现在生效的值（同 core/setting-read.ts 的 settingValue；platform 不能引 core）。
 *  生效 = 没删、没撤销，判断同 shared/logic/live-row.ts 的 isLiveRow；这里抄一行不引它：引了以后入口懒加载本模块要多带一个分包 */
export interface LookRow {
  readonly key?: unknown;
  readonly value?: unknown;
  readonly deleted_at?: unknown;
  readonly undone?: unknown;
}
export const lookOfRows = (rows: readonly LookRow[]): Look => lookOf((k) => rows.find((r) => r.key === LOOK_KEYS[k] && r.deleted_at == null && r.undone !== true)?.value);

let current: Look | null = null;
let log: LookLog | null = null;
let painted = '';
let font = 'system';
const sys: Record<'dark' | 'rt' | 'rm', MediaQueryList | null> = { dark: null, rt: null, rm: null };

/** 页面要求强制实色（隐私记页挂着时，B5 TC-B5-12）：计数，> 0 时 data-rt 一直是 1 */
let solidHolds = 0;
const rtNow = (): boolean => sys.rt?.matches === true || solidHolds > 0;

function paintRt(): void {
  const r = document.documentElement;
  if (rtNow()) r.dataset['rt'] = '1';
  else delete r.dataset['rt'];
}

/**
 * 隐私记页（B5 TC-B5-12）：挂着时底栏和“＋”用实色、不建液态玻璃副本，做法同“减少透明效果”。
 * 走本模块的同一个判断（不另写 data-rt），重画时不会被冲掉；返回的函数放开（多次调用只算一次），之后按系统设置重算
 */
export function holdReducedTransparency(): () => void {
  solidHolds += 1;
  paintRt();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    solidHolds -= 1;
    paintRt();
  };
}

function paint(): void {
  if (!current) return;
  const r = document.documentElement;
  const theme = current.theme === 'system' ? (sys.dark?.matches ? 'dark' : 'light') : current.theme;
  const rt = rtNow();
  const rm = sys.rm?.matches === true;
  r.dataset['skin'] = current.skin;
  r.dataset['theme'] = theme;
  if (rt) r.dataset['rt'] = '1';
  else delete r.dataset['rt'];
  if (rm) r.dataset['rm'] = '1';
  else delete r.dataset['rm'];
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
        // 分包下载不了（断网、刚发了新版）：退回原值，下次再套时重试；设置页的状态由 fonts.ts 自己报（它同样下载不了时页面也打不开）
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
    for (const q of Object.values(sys)) q?.addEventListener('change', paint);
  }
  const same = current !== null && JSON.stringify(current) === JSON.stringify(look);
  current = look;
  try {
    localStorage.setItem(LOOK_CACHE_KEY, JSON.stringify(look));
  } catch {
    // 写不进（隐私模式、配额满）：这次照样生效，只是下次启动先按默认
  }
  if (!same) paint();
}

/** 本机缓存的那一份（没有、坏了按默认：简洁、跟随系统、系统字体） */
export function cachedLook(): Look {
  let o: Partial<Record<keyof Look, unknown>> = {};
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LOOK_CACHE_KEY) ?? '{}');
    if (v && typeof v === 'object') o = v;
  } catch {
    // 读不到、不是 JSON：按默认
  }
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
// 换回系统字体以后还有没清的字体缓存（platform/fonts.ts 的 pv-font-gc）：交给 fonts.ts 到点清掉（系统字体平时不加载它）
try {
  if (font === 'system' && /"at":[1-9]/.test(localStorage.getItem('pv-font-gc') ?? '')) void import('./fonts.ts').then((m) => m.applyFont('system'), () => undefined);
} catch {
  // 读不到本机存储：不清
}
