// 界面语言的选择规则（架构 16.4，R-75）。首页的 Pages Function、App、注册页共用这一份。
// 纯函数：不碰 DOM、cookie、localStorage，调用方把读到的值传进来。

export type Locale = 'zh' | 'ko';

export const DEFAULT_LOCALE: Locale = 'zh';

/** 首页手动切换语言时写的 cookie 名（16.4） */
export const LANG_COOKIE = 'lemo_lang';

/** 本机保存的语言选择（localStorage 键，16.4） */
export const LOCALE_STORAGE_KEY = 'pv-locale';

/** 只认精确的 'zh' / 'ko'，别的一律当没选过 */
export function asLocale(v: string | null | undefined): Locale | null {
  return v === 'zh' || v === 'ko' ? v : null;
}

/** profiles.ui_locale 存的值（0001 的 check 约束只许这两个） */
export type UiLocale = 'zh-CN' | 'ko-KR';

const TO_UI: Readonly<Record<Locale, UiLocale>> = { zh: 'zh-CN', ko: 'ko-KR' };

/**
 * profiles.ui_locale → pickLocale 认的 'zh' / 'ko'（架构 0.31 第 12 条）。
 * ui_locale 存的是 'zh-CN' / 'ko-KR'，直接传给 pickLocale 会被当成“没选过”，所以先转。
 * 只认这两个精确值；别的（null、''、'zh'、大小写不同）返回 null，App 接着按 pv-locale → cookie → navigator.languages 往下取。
 */
export function fromUiLocale(v: string | null | undefined): Locale | null {
  if (v === 'zh-CN') return 'zh';
  if (v === 'ko-KR') return 'ko';
  return null;
}

/** 'zh' / 'ko' → 写回 profiles.ui_locale 的值（架构 0.31 第 12 条） */
export function toUiLocale(locale: Locale): UiLocale {
  return TO_UI[locale];
}

/**
 * 规则：
 * 1. 手动选过的语言（saved）优先；
 * 2. 否则按设备语言列表从前往后，第一个以 ko 或 zh 开头的：ko → 韩文，zh → 中文；
 * 3. 都没有，默认中文。
 */
export function pickLocale(saved: string | null | undefined, langs: readonly string[]): Locale {
  const s = asLocale(saved);
  if (s) return s;
  for (const raw of langs) {
    const tag = raw.trim().toLowerCase();
    // 只认语言主标签：ko、ko-KR、zh、zh-Hans-CN；kok（孔卡尼语）、zhx 这类不算
    if (tag === 'ko' || tag.startsWith('ko-')) return 'ko';
    if (tag === 'zh' || tag.startsWith('zh-')) return 'zh';
  }
  return DEFAULT_LOCALE;
}

/**
 * 把 Accept-Language 拆成语言列表：按 q 从高到低（同 q 保持原顺序），去掉 q=0 和 `*`。
 * 浏览器发来的本来就是降序，所以结果等于“从前往后”。
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  const items: { tag: string; q: number; i: number }[] = [];
  header.split(',').forEach((part, i) => {
    const [tagPart, ...params] = part.trim().split(';');
    const tag = (tagPart ?? '').trim();
    if (!tag || tag === '*' || tag.length > 35) return;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=(.*)$/i.exec(p);
      // 坏格式的 q（如 q=abc）按 NaN 处理，整项丢掉
      if (m) q = /^\s*[0-9.]+\s*$/.test(m[1] ?? '') ? Number(m[1]) : Number.NaN;
    }
    if (!Number.isFinite(q) || q <= 0) return;
    items.push({ tag, q, i });
  });
  items.sort((a, b) => b.q - a.q || a.i - b.i);
  return items.map((x) => x.tag);
}

/** 从 Cookie 请求头里取 lemo_lang；取不到或值不对返回 null */
export function localeFromCookieHeader(cookie: string | null | undefined): Locale | null {
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === LANG_COOKIE) return asLocale(part.slice(eq + 1).trim());
  }
  return null;
}
