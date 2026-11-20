// 可选字体的加载（架构 5.9c 第 3 点；R-128、R-135；B6 字体 11-13，整块评审 11-14 返工）。只在选了系统字体以外的字体时由 platform/look.ts 懒加载，首屏不带。
// • 清单 /app/fonts-index.json 由 build/fonts.py 生成（11-14 起不进 SW 预缓存，SW 先联网、失败用 lemo-font-index 缓存：系统字体的人不下载它，读过一次离线也读得到）：每种字体的样式地址、确认用的中韩 family 和样例字、
//   预取分片（地址、sha256）、全部文件。清单里没有的 id（登记删了、更新版本才有、源字体文件还没放进仓库）一律按系统字体，不提示也不写回设置（5.9c 第 4 点）。
// • 第一次套：预取分片（常用字）逐个下载、核对 sha256（进 SW 的 lemo-fonts 缓存，离线常用字也能显示），按完成数报“下载中 xx%”；
//   再在 <head> 加同源的 <link rel="stylesheet">（CSP 不放宽），document.fonts.load 用中文、韩文样例各确认一次（返回空也算失败），
//   最后才设 <html data-font>，样式里 :root[data-font] 换掉 --f-zh、--f-ko（和 --f-num）。没确认之前一直是系统字体。
//   确认过的字体和样式地址记在本机（pv-font-ok）。
// • 冷启动：上次确认过的同一种字体直接加 link、设 data-font（不等下载、不闪），后台再静默走一遍上面的核对；核对不过才回系统字体、报失败。
// • 失败（离线、20 秒没有进展（每下完一个分片重新计，11-14 真机日志 font_timeout pct=57 后改）、哈希不对、样式加载不了、确认不到）：拿掉 link 和 data-font 回到系统字体，设置值不改，状态 fail（设置页“重试”）；
//   下次打开 App 时 look.ts 会再套一次。哈希不对的那个分片先从缓存删掉再报失败。每次加载一个 AbortController：超时或被下一次顶掉就中止下载。
// • 缓存清理（5.9c）：换字体（含换回系统字体）一天以后，删掉 lemo-fonts 里不属于当前字体的文件（pv-font-gc 记换的时刻）
// • 运行日志 font_load（look.ts 传进来的 log）：开始、完成、失败各一行，itemId 是字体 id，code 写阶段、错误码、耗时、进度
// • 状态给设置页用：fontState.get / subscribe（useSyncExternalStore）
const INDEX_URL = '/app/fonts-index.json';
const LINK_ID = 'lemo-font';
const CACHE = 'lemo-fonts';
const OK_KEY = 'pv-font-ok';
const GC_KEY = 'pv-font-gc';
export const FONT_TIMEOUT_MS = 20_000;
export const FONT_GC_MS = 24 * 60 * 60 * 1000;

export interface FontEntry {
  id: string;
  label: { zh: string; ko: string };
  css: string;
  family: string;
  sample: string;
  familyKo: string;
  sampleKo: string;
  prefetch: Array<{ url: string; sha256: string }>;
  files: string[];
}

export type FontStatus = 'ok' | 'loading' | 'fail';
export interface FontState {
  /** 想用的字体（设置里的值；清单里没有的已按 system 算） */
  id: string;
  status: FontStatus;
  /** 下载进度 0～100（按预取分片数） */
  pct: number;
}
export type FontLog = (act: string, f: { code?: string; itemId?: string }) => void;

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

class FontError extends Error {}

let index: Promise<FontEntry[]> | null = null;
/** 可选字体清单（读不到按空：只有系统字体；下次再读） */
export function fontIndex(): Promise<FontEntry[]> {
  index ??= fetch(INDEX_URL)
    .then((r) => (r.ok ? (r.json() as Promise<{ fonts?: FontEntry[] }>) : Promise.reject(new FontError(`index_${String(r.status)}`))))
    .then((j) => (Array.isArray(j.fonts) ? j.fonts : []))
    .catch((e: unknown) => {
      index = null;
      log?.('font_load', { code: `index ${e instanceof FontError ? e.message : 'index_net'}` });
      return [];
    });
  return index;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const dropCached = (url: string) => (typeof caches === 'undefined' ? Promise.resolve(false) : caches.open(CACHE).then((c) => c.delete(url)).catch(() => false));

function local<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}
function keep(key: string, v: unknown): void {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // 隐私模式写不进：只是下次冷启动不走快路、缓存不清
  }
}

async function fetchChecked(p: { url: string; sha256: string }, signal: AbortSignal): Promise<void> {
  const r = await fetch(p.url, { signal });
  if (!r.ok) throw new FontError(`font_shard_${String(r.status)}`);
  if (hex(await crypto.subtle.digest('SHA-256', await r.arrayBuffer())) !== p.sha256) {
    await dropCached(p.url);
    throw new FontError('font_shard_hash');
  }
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
    el.onerror = () => no(new FontError('font_css'));
  });
  document.head.append(el);
  return p;
}

function drop(): void {
  delete document.documentElement.dataset['font'];
  document.getElementById(LINK_ID)?.remove();
}

/** 换字体一天以后清掉缓存里不属于当前字体的文件（keep 是当前字体的全部文件地址，系统字体为空） */
async function gc(id: string, files: readonly string[]): Promise<void> {
  const g = local<{ id: string; at: number }>(GC_KEY);
  if (!g || g.id !== id) return keep(GC_KEY, { id, at: Date.now() });
  if (g.at === 0 || Date.now() - g.at < FONT_GC_MS || typeof caches === 'undefined') return;
  const c = await caches.open(CACHE);
  const own = new Set(files);
  for (const req of await c.keys()) if (!own.has(new URL(req.url).pathname)) await c.delete(req);
  keep(GC_KEY, { id, at: 0 });
}

let ctl: AbortController | null = null;
let log: FontLog | null = null;

/** 换成这种字体（'system' = 系统字体）；同时只认最后一次 */
export async function applyFont(id: string, l?: FontLog): Promise<void> {
  if (l) log = l;
  ctl?.abort();
  const my = new AbortController();
  ctl = my;
  // 还是不是最后一次（被下一次顶掉就不再改状态）；超时也会 abort，但仍是最后一次，要报失败
  const live = () => ctl === my;
  const t0 = Date.now();
  const ok = local<{ id: string; css: string }>(OK_KEY);
  const fast = id !== 'system' && ok?.id === id;
  if (id !== 'system') log?.('font_load', { itemId: id, code: `start ${fast ? 'cached' : 'download'}` });
  if (fast && ok) {
    // 上次确认过：直接套上，后台静默核对
    void linkFor(ok.css).catch(() => undefined);
    document.documentElement.dataset['font'] = id;
    set({ id, status: 'ok', pct: 100 });
  }
  const entry = id === 'system' ? undefined : (await fontIndex()).find((f) => f.id === id);
  if (!live()) return;
  if (!entry) {
    drop();
    keep(OK_KEY, null);
    set({ id: 'system', status: 'ok', pct: 100 });
    await gc('system', []).catch(() => undefined);
    return;
  }
  if (!fast) set({ id, status: 'loading', pct: 0 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pct = 0;
  let stalled: (e: FontError) => void = () => undefined;
  /** 停滞计时（11-14 真机日志：整段 20 秒总时限在 57% 处掐断，网速慢但一直在下的也算失败）：每下完一个分片重新计 */
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      my.abort();
      stalled(new FontError('font_timeout'));
    }, FONT_TIMEOUT_MS);
  };
  try {
    const timeout = new Promise<never>((_, no) => {
      stalled = no;
    });
    arm();
    const work = (async () => {
      for (const [i, p] of entry.prefetch.entries()) {
        await fetchChecked(p, my.signal);
        // 超时、被下一次顶掉都会 abort：后面的分片不再下，也不再改状态（不然会把已报的 fail 改回 loading）
        if (my.signal.aborted) return;
        arm();
        pct = Math.min(99, Math.round(((i + 1) * 100) / entry.prefetch.length));
        if (!fast) set({ id, status: 'loading', pct });
      }
      if (my.signal.aborted) return;
      await linkFor(entry.css);
      const faces = await Promise.all([document.fonts.load(`400 16px "${entry.family}"`, entry.sample), document.fonts.load(`400 16px "${entry.familyKo}"`, entry.sampleKo)]);
      if (faces.some((f) => f.length === 0)) throw new FontError('font_face_none');
    })();
    await Promise.race([work, timeout]);
    if (!live()) return;
    document.documentElement.dataset['font'] = id;
    keep(OK_KEY, { id, css: entry.css });
    set({ id, status: 'ok', pct: 100 });
    log?.('font_load', { itemId: id, code: `ok ms=${String(Date.now() - t0)} pct=100` });
  } catch (e) {
    if (!live()) return;
    const code = e instanceof FontError ? e.message : 'font_net';
    drop();
    keep(OK_KEY, null);
    set({ id, status: 'fail', pct: 0 });
    log?.('font_load', { itemId: id, code: `fail ${code} ms=${String(Date.now() - t0)} pct=${String(pct)}` });
  } finally {
    clearTimeout(timer);
  }
  await gc(id, entry.files).catch(() => undefined);
}

/** 设置页“重试” */
export const retryFont = (): Promise<void> => applyFont(state.id);
