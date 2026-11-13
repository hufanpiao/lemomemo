// 可选字体的加载（架构 5.9c 第 3 点；R-128、R-135；B6 字体 11-13）。只在选了系统字体以外的字体时由 platform/look.ts 懒加载，首屏不带。
// • 清单 /app/fonts-index.json 由 build/fonts.py 生成（进 SW 预缓存，离线也读得到）：每种字体的样式地址、确认用的 family 和样例字、预取分片（地址、sha256）。
//   清单里没有的 id（登记删了、更新版本才有、源字体文件还没放进仓库）一律按系统字体，不提示也不写回设置（5.9c 第 4 点）。
// • 套上：先把预取分片（常用字）逐个下载、核对 sha256（进 SW 的 lemo-fonts 缓存，离线常用字也能显示），按完成数报“下载中 xx%”；
//   再在 <head> 加同源的 <link rel="stylesheet">（CSP 不放宽），document.fonts.load 用样例字确认，最后才设 <html data-font>，
//   样式里 :root[data-font] 换掉 --f-zh、--f-ko（和 --f-num）。没确认之前一直是系统字体，不会半路换一半。
// • 失败（离线、20 秒超时、哈希不对、样式加载不了）：拿掉 link 和 data-font 回到系统字体，设置值不改，状态 fail（设置页显示“没下载成功，先用系统字体 · 重试”）；
//   下次打开 App 时 look.ts 会再套一次。
// • 状态给设置页用：fontState.get / subscribe（useSyncExternalStore）
const INDEX_URL = '/app/fonts-index.json';
const LINK_ID = 'lemo-font';
const TIMEOUT_MS = 20_000;

export interface FontEntry {
  id: string;
  label: { zh: string; ko: string };
  css: string;
  family: string;
  sample: string;
  prefetch: Array<{ url: string; sha256: string }>;
}

export type FontStatus = 'ok' | 'loading' | 'fail';
export interface FontState {
  /** 想用的字体（设置里的值；清单里没有的已按 system 算） */
  id: string;
  status: FontStatus;
  /** 下载进度 0～100（按预取分片数） */
  pct: number;
}

let state: FontState = { id: 'system', status: 'ok', pct: 100 };
const subs = new Set<() => void>();
function set(s: FontState): void {
  state = s;
  for (const l of subs) l();
}
export const fontState = {
  get: (): FontState => state,
  subscribe(l: () => void): () => void {
    subs.add(l);
    return () => subs.delete(l);
  },
};

let index: Promise<FontEntry[]> | null = null;
/** 可选字体清单（读不到按空：只有系统字体；下次再读） */
export function fontIndex(): Promise<FontEntry[]> {
  index ??= fetch(INDEX_URL)
    .then((r) => (r.ok ? (r.json() as Promise<{ fonts?: FontEntry[] }>) : Promise.reject(new Error(String(r.status)))))
    .then((j) => (Array.isArray(j.fonts) ? j.fonts : []))
    .catch(() => {
      index = null;
      return [];
    });
  return index;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function fetchChecked(p: { url: string; sha256: string }): Promise<void> {
  const r = await fetch(p.url);
  if (!r.ok) throw new Error(`font_shard_${String(r.status)}`);
  if (hex(await crypto.subtle.digest('SHA-256', await r.arrayBuffer())) !== p.sha256) throw new Error('font_shard_hash');
}

function linkFor(css: string): Promise<void> {
  let l = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (l?.getAttribute('href') === css && l.sheet) return Promise.resolve();
  l?.remove();
  l = document.createElement('link');
  l.id = LINK_ID;
  l.rel = 'stylesheet';
  l.href = css;
  const el = l;
  const p = new Promise<void>((ok, no) => {
    el.onload = () => ok();
    el.onerror = () => no(new Error('font_css'));
  });
  document.head.append(el);
  return p;
}

function drop(): void {
  delete document.documentElement.dataset['font'];
  document.getElementById(LINK_ID)?.remove();
}

let seq = 0;
/** 换成这种字体（'system' = 系统字体）；同时只认最后一次 */
export async function applyFont(id: string): Promise<void> {
  const my = ++seq;
  const entry = id === 'system' ? undefined : (await fontIndex()).find((f) => f.id === id);
  if (my !== seq) return;
  if (!entry) {
    drop();
    set({ id: 'system', status: 'ok', pct: 100 });
    return;
  }
  if (document.documentElement.dataset['font'] === id) return set({ id, status: 'ok', pct: 100 });
  set({ id, status: 'loading', pct: 0 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 超时、失败或被下一次顶掉以后，后台还没下完的那几步不再报进度、不再挂 link
  let over = false;
  const live = () => !over && my === seq;
  try {
    let done = 0;
    const work = (async () => {
      for (const p of entry.prefetch) {
        await fetchChecked(p);
        done += 1;
        if (live()) set({ id, status: 'loading', pct: Math.min(99, Math.round((done * 100) / entry.prefetch.length)) });
      }
      if (!live()) return;
      await linkFor(entry.css);
      await document.fonts.load(`400 16px "${entry.family}"`, entry.sample);
    })();
    await Promise.race([work, new Promise((_, no) => (timer = setTimeout(() => no(new Error('font_timeout')), TIMEOUT_MS)))]);
    if (my !== seq) return;
    document.documentElement.dataset['font'] = id;
    set({ id, status: 'ok', pct: 100 });
  } catch {
    if (my !== seq) return;
    drop();
    set({ id, status: 'fail', pct: 0 });
  } finally {
    over = true;
    clearTimeout(timer);
  }
}

/** 设置页“重试” */
export const retryFont = (): Promise<void> => applyFont(state.id);
