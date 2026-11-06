// 设置 › 关于：连点“版本”5 下显示的只读诊断信息（11-06，负责人主屏幕版“底栏不透、顶部带没有模糊”，要看真机到底跑的是哪一版、写法认不认）
// • 只在本机读、只显示：不收集个人数据、不上报、不写任何存储；读不到的项写 “?”，没有的写 none / absent，整个函数不抛（内容是技术字段，不翻译，A20 不写汉字）
// • 第一行是最关键的：构建提交号、版本、构建时刻；第二行起是 SW（控制本页的脚本、各状态、缓存名）——主屏幕版可能还在用旧 SW 预缓存的旧版本
// • navigator.serviceWorker 只准出现在 platform（A13），所以放在这里
import { buildInfo } from './env.ts';

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

/** 真机上安全区、视口、页面顶部留白到底是多少（11-06 真机截图：顶部带只在安全区下沿一窄条起作用、页面顶部多空了约 90pt） */
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
    `fixedTop0=${probeTop} inner=${win.innerWidth}x${win.innerHeight} screen=${win.screen.width}x${win.screen.height} vv=${vv ? `${vv.width}x${vv.height}+${vv.offsetTop}` : '-'} scrollY=${win.scrollY}`,
    `#root.padding-top=${rootEl ? win.getComputedStyle(rootEl).paddingTop : '-'} main.padding-top=${main ? win.getComputedStyle(main).paddingTop : '-'} main.top=${main ? Math.round(main.getBoundingClientRect().top) : '-'} first.top=${first ? Math.round(first.getBoundingClientRect().top) : '-'} banner=${doc.documentElement.hasAttribute('data-top-banner')}`,
  ].join(' ');
}

/** 收集诊断信息，一行一项。win 默认 window（测试时传假的） */
export async function collectDiag(win: Window = window): Promise<string[]> {
  const doc = win.document;
  const root = doc.documentElement;
  const sup = (p: string, v: string): string => String(safe(() => CSS.supports(p, v), false));
  const mm = (q: string): string => String(safe(() => win.matchMedia(q).matches, false));
  const bar = doc.querySelector('[data-testid="tabbar"]');
  const fab = bar?.nextElementSibling instanceof HTMLButtonElement ? bar.nextElementSibling : null;
  const lines = [
    `build: commit=${buildInfo.commit} version=${buildInfo.version} builtAt=${buildInfo.builtAt} env=${buildInfo.env}`,
    ...(await swLines(win.navigator, win).catch(() => ['sw: ?'])),
    `css: ${cssFiles(doc)}`,
    `standalone: ${mm('(display-mode: standalone)')} ua=${win.navigator.userAgent}`,
    `supports: -webkit-backdrop-filter=${sup('-webkit-backdrop-filter', 'blur(1px)')} backdrop-filter=${sup('backdrop-filter', 'blur(1px)')} nospace=${sup('-webkit-backdrop-filter', 'blur(8px)saturate(1.8)')}`,
    safe(() => geoLine(win), 'geo: ?'),
    `media: reduced-transparency=${mm('(prefers-reduced-transparency: reduce)')} reduced-motion=${mm('(prefers-reduced-motion: reduce)')}`,
    `html: data-rt=${root.dataset['rt'] ?? '-'} data-skin=${root.dataset['skin'] ?? '-'} data-theme=${root.dataset['theme'] ?? '-'} data-glass=${root.dataset['glass'] ?? '-'}`,
    `bar.data-glass=${bar?.getAttribute('data-glass') ?? '-'} data-ad=${bar?.getAttribute('data-ad') ?? '-'}`,
    styleLine('.bar', bar, null, GLASS_KEYS, win),
    styleLine('.fab', fab, null, GLASS_KEYS, win),
    styleLine('html::before', root, '::before', PSEUDO_KEYS, win),
    styleLine('body::before', doc.body, '::before', PSEUDO_KEYS, win),
    styleLine('body::after', doc.body, '::after', PSEUDO_KEYS, win),
  ];
  return lines;
}
