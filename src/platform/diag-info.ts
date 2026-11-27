// 设置 › 关于：连点“版本”5 下显示的只读诊断信息（看真机跑的是哪一版、写法认不认）
// • 只在本机读、只显示：不收集个人数据、不上报、不写任何存储；读不到写 “?”，没有写 none / absent，不抛（技术字段，不翻译、不写汉字）
// • 第一行是构建提交号、版本、构建时刻；第二行起是 SW 状态和缓存名（主屏幕版可能还在用旧 SW 预缓存的旧版本）
// • navigator.serviceWorker 只准出现在 platform，所以放在这里
import { buildInfo } from './env.ts';
import { fontState } from './fonts.ts';
import { insetTimeline, type InsetTimeline } from './inset-watch.ts';
import { BAR_SELECTOR } from './run-log-api.ts';

/** 诊断里的启动时间线一行（只有这里用，不跟着首屏下载）：launch: standalone=… painted=+300 ready=+460(quiet) | +12 env-bottom=0px inner=956 | … */
export function insetTimelineLine(tl: InsetTimeline = insetTimeline()): string {
  const head = `launch: standalone=${tl.standalone} painted=${tl.paintedAt === null ? '-' : `+${tl.paintedAt}`} ready=${tl.readyAt === null ? '-' : `+${tl.readyAt}`}(${tl.reason ?? 'wait'})`;
  return [head, ...tl.rows.map((r) => `+${r.t} env-bottom=${r.env} inner=${r.inner} screen=${r.screen}`)].join(' | ');
}

/** 计算样式里要看的几项（伪元素和玻璃块） */
const PSEUDO_KEYS = ['content', 'position', 'z-index', 'height', '-webkit-backdrop-filter', 'backdrop-filter', 'background-image', 'background-color', '-webkit-mask-image', 'mask-image'] as const;
const GLASS_KEYS = ['-webkit-backdrop-filter', 'backdrop-filter', 'background-color', 'background-image'] as const;

const safe = <T>(f: () => T, fb: T): T => {
  try {
    return f();
  } catch {
    return fb;
  }
};

/** 字体状态：想用哪种、ok / loading / fail、进度 */
const fontLine = (): string => {
  const f = fontState.get();
  return `${f.id} ${f.status} ${String(f.pct)}%`;
};

function styleLine(name: string, el: Element | null, pseudo: string | null, keys: readonly string[], win: Window): string {
  if (!el) return `${name}: absent`;
  const cs = safe(() => win.getComputedStyle(el, pseudo), null);
  if (!cs) return `${name}: ?`;
  return `${name}: ${keys.map((k) => `${k}=${cs.getPropertyValue(k) || '-'}`).join(' | ')}`;
}

/** 页面引用的样式表文件名（带内容哈希，能看出是哪一次构建） */
function cssFiles(doc: Document): string {
  const hrefs = [...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((l) => l.href.split('/').pop() ?? '');
  return hrefs.length > 0 ? hrefs.join(', ') : '-';
}

async function swLines(nav: Navigator, win: Window): Promise<string[]> {
  if (!('serviceWorker' in nav)) return ['sw: unsupported'];
  const ctl = nav.serviceWorker.controller;
  const out = [`sw.controller: ${ctl ? `${ctl.scriptURL} (${ctl.state})` : 'none'}`];
  const reg = await nav.serviceWorker.getRegistration('/app/').catch(() => undefined);
  out.push(reg ? `sw.reg: active=${reg.active?.state ?? '-'} waiting=${reg.waiting?.state ?? '-'} installing=${reg.installing?.state ?? '-'}` : 'sw.reg: none');
  const keys = 'caches' in win ? await win.caches.keys().catch(() => null) : null;
  out.push(`caches: ${keys ? keys.join(', ') || '-' : '?'}`);
  return out;
}

/** 真机上安全区、视口、页面顶部留白各是多少。
 * screen-inner = screen.height − innerHeight：正常主屏幕版是 0，约等于顶部安全区就是少算了状态栏那一截 */
function geoLine(win: Window): string {
  const doc = win.document;
  const probe = doc.createElement('div');
  probe.style.setProperty('position', 'fixed');
  probe.style.setProperty('top', '0');
  probe.style.setProperty('visibility', 'hidden');
  probe.style.setProperty('padding-top', 'env(safe-area-inset-top)');
  doc.body.append(probe);
  const env = safe(() => win.getComputedStyle(probe).paddingTop, '?');
  const probeTop = safe(() => probe.getBoundingClientRect().top, NaN);
  probe.remove();
  const rootCs = win.getComputedStyle(doc.documentElement);
  const vv = win.visualViewport;
  const main = doc.querySelector('main');
  const first = main ? [...main.querySelectorAll('*')].find((e) => e.getBoundingClientRect().height > 0) : null;
  const rootEl = doc.getElementById('root');
  return [
    `geo: env-top=${env} --inset-top=${rootCs.getPropertyValue('--inset-top').trim() || '-'} --safe-top=${rootCs.getPropertyValue('--safe-top').trim() || '-'} --top-fade=${rootCs.getPropertyValue('--top-fade').trim() || '-'}`,
    `fixedTop0=${probeTop} inner=${win.innerWidth}x${win.innerHeight} screen=${win.screen.width}x${win.screen.height} screen-inner=${win.screen.height - win.innerHeight} vv=${vv ? `${vv.width}x${vv.height}+${vv.offsetTop}` : '-'} scrollY=${win.scrollY}`,
    `#root.padding-top=${rootEl ? win.getComputedStyle(rootEl).paddingTop : '-'} main.padding-top=${main ? win.getComputedStyle(main).paddingTop : '-'} main.top=${main ? Math.round(main.getBoundingClientRect().top) : '-'} first.top=${first ? Math.round(first.getBoundingClientRect().top) : '-'} banner=${doc.documentElement.hasAttribute('data-top-banner')}`,
  ].join(' ');
}

/** 收集诊断信息，一行一项。win 默认 window（测试时传假的） */
export async function collectDiag(win: Window = window): Promise<string[]> {
  const doc = win.document;
  const root = doc.documentElement;
  const sup = (p: string, v: string): string => String(safe(() => CSS.supports(p, v), false));
  const mm = (q: string): string => String(safe(() => win.matchMedia(q).matches, false));
  const bar = doc.querySelector(BAR_SELECTOR);
  const fab = bar?.nextElementSibling instanceof HTMLButtonElement ? bar.nextElementSibling : null;
  const lines = [
    `build: commit=${buildInfo.commit} version=${buildInfo.version} builtAt=${buildInfo.builtAt} env=${buildInfo.env}`,
    ...(await swLines(win.navigator, win).catch(() => ['sw: ?'])),
    `css: ${cssFiles(doc)}`,
    `standalone: ${mm('(display-mode: standalone)')} ua=${win.navigator.userAgent}`,
    `supports: -webkit-backdrop-filter=${sup('-webkit-backdrop-filter', 'blur(1px)')} backdrop-filter=${sup('backdrop-filter', 'blur(1px)')} nospace=${sup('-webkit-backdrop-filter', 'blur(8px)saturate(1.8)')}`,
    safe(() => geoLine(win), 'geo: ?'),
    // 启动时间线：底部安全区、innerHeight 每次变化的时刻，和什么时候淡入底栏
    safe(() => insetTimelineLine(), 'launch: ?'),
    `media: reduced-transparency=${mm('(prefers-reduced-transparency: reduce)')} reduced-motion=${mm('(prefers-reduced-motion: reduce)')}`,
    `html: data-rt=${root.dataset['rt'] ?? '-'} data-solid=${root.dataset['solid'] ?? '-'} data-rm=${root.dataset['rm'] ?? '-'} data-font=${root.dataset['font'] ?? '-'} data-skin=${root.dataset['skin'] ?? '-'} data-theme=${root.dataset['theme'] ?? '-'} data-glass=${root.dataset['glass'] ?? '-'}`,
    `font: ${safe(fontLine, 'font: ?')}`,
    `bar.data-glass=${bar?.getAttribute('data-glass') ?? '-'}`,
    styleLine('.bar', bar, null, GLASS_KEYS, win),
    styleLine('.fab', fab, null, GLASS_KEYS, win),
    // 顶部模糊带：两层模糊是入口页里的真元素 .lemo-top-8、.lemo-top-2，底色条是 body::before
    styleLine('.lemo-top-8', doc.querySelector('.lemo-top-8'), null, PSEUDO_KEYS, win),
    styleLine('body::before', doc.body, '::before', PSEUDO_KEYS, win),
    styleLine('.lemo-top-2', doc.querySelector('.lemo-top-2'), null, PSEUDO_KEYS, win),
  ];
  return lines;
}
