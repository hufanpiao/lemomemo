// 时区的通俗说法（前后端共用一份）：邮件（supabase/functions/_shared/account-mail.ts，经 _shared/gen/i18n/tz-label.ts 由 index.ts 注入）
// 和 App 恢复页（auth.restore.when 的 {zone}）都从这里取，括号里写“한국 시간 / 韩国时间”这类读者看得懂的说法，不写 IANA 代码。
// 依据：docs/03-评审/B2/B2-韩文审校-账号信防钓鱼与时区.md 第三节（T-4、T-6～T-9）；接手清单 KO-mail-nolink-tz。
// • 常用时区写死（fixedTzLabel）：字样不随运行环境的 ICU 版本变（Node 写“미 동부 시간”、Deno 写“북미 동부 시간”），也不分冬夏令
//   （不写“표준시 / 标准时间”）。用 switch 挑词条（不拿变量当键，check_backend F7），文字在 shared/i18n/tz-zh.ts、tz-ko.ts 的 tz.*（A20）；别名时区归并到同一条。
// • 表外的按信的语言取 Intl 的 longGeneric 通称；说法里有拉丁字母（Deno 对缺本地化城市名的时区会拼“Honolulu 시간”，
//   或者只给 GMT±hh:mm）、取不到、运行环境不认 longGeneric 时，一律退回 IANA 名（总比中韩文里夹英文强）。
// • 加一条要同时加 tz-zh.ts、tz-ko.ts 的词条，改 tests/functions/account-mail-nolink.test.ts 的逐字期望，并送韩文审校。
import { createT, type Locale } from './i18n.ts';
import { tzKo } from './tz-ko.ts';
import { tzZh, type TzMsgKey } from './tz-zh.ts';

type TzKey = TzMsgKey;

/** 时区词典自己的 t（11-05 词条从公共词典挪到 tz-zh.ts、tz-ko.ts，不进主 App 首屏） */
const tTz = createT({ zh: tzZh, ko: tzKo });

/** 时区说法的取法：邮件经依赖注入拿到的就是 tzLabel 本身。at 是按哪个时刻的时区归属取表外时区的说法（epoch ms），不传按 LABEL_REF_MS */
export type TzLabeler = (zone: string, loc: Locale, at?: number) => string;

/**
 * 写死的那些（含别名）挑哪个词条；不在其中的回 null。文字在 shared/i18n/tz-zh.ts、tz-ko.ts（A20：文字只放词典）。
 * 别名分支要留全：canonicalTz 在各内核上归一的方向不同（11-05 实测，见 canonicalTz 的说明），
 * WebKit 只统一大小写、别名原样返回（ROK、US/Eastern、GB 都不变），V8 反而把 Asia/Ho_Chi_Minh 归成旧名 Asia/Saigon。
 * 所以每个时区的现行名和常见别名都要在这里，不能指望规范化后只剩一种写法（tests/shared/tz-canonical.test.ts 逐个核对）
 */
function fixedKey(zone: string): TzKey | null {
  switch (zone) {
    case 'Asia/Seoul': case 'ROK': return 'tz.kr';
    case 'Asia/Shanghai': case 'Asia/Chongqing': case 'Asia/Chungking': case 'Asia/Harbin': case 'PRC': return 'tz.cn';
    case 'Asia/Tokyo': case 'Japan': return 'tz.jp';
    case 'Asia/Hong_Kong': case 'Hongkong': return 'tz.hk';
    case 'Asia/Taipei': case 'ROC': return 'tz.tw';
    case 'Asia/Singapore': case 'Singapore': return 'tz.sg';
    case 'Asia/Bangkok': return 'tz.th';
    case 'Asia/Ho_Chi_Minh': case 'Asia/Saigon': return 'tz.vn';
    case 'America/New_York': case 'US/Eastern': return 'tz.usEast';
    case 'America/Chicago': case 'US/Central': return 'tz.usCentral';
    case 'America/Denver': case 'US/Mountain': case 'Navajo': case 'America/Shiprock': return 'tz.usMountain';
    case 'America/Los_Angeles': case 'US/Pacific': case 'US/Pacific-New': return 'tz.usWest';
    case 'Pacific/Honolulu': case 'US/Hawaii': case 'Pacific/Johnston': return 'tz.hawaii';
    case 'Europe/London': case 'GB': case 'Europe/Belfast': return 'tz.uk';
    case 'Europe/Paris': case 'Europe/Berlin': return 'tz.cet';
    case 'Australia/Sydney': case 'Australia/NSW': case 'Australia/ACT': case 'Australia/Canberra': return 'tz.auEast';
    default: return null;
  }
}

/** 写死的那些的说法；不在其中的回 null */
export function fixedTzLabel(zone: string, loc: Locale): string | null {
  const key = fixedKey(zone);
  return key === null ? null : tTz(key, {}, loc);
}

/** Intl 给的说法能不能用：空的、含拉丁字母的（GMT±hh:mm、“Honolulu 시간”这类）都不用，退回 IANA 名 */
export function labelFromIntl(zone: string, intlName: string): string {
  return intlName !== '' && !/[A-Za-z]/.test(intlName) ? intlName : zone;
}

/**
 * 不传 at 时按这个时刻的时区归属取说法（2026-01-01 00:00 UTC）：A2 不准 shared 自己取当前时间，又不能退回 1970 年。
 * 已知的归属变化（基辅等地 1990 年代、加沙、廷布等）都在它之前，所以说法和现在一致。
 * 以后哪个时区改了归属：调用方改传要说的那个时刻（邮件是信里的时刻），或者把这个参照时刻往后挪，并补用例
 */
export const LABEL_REF_MS = Date.UTC(2026, 0, 1);

/**
 * 表外时区：Intl 的 longGeneric（不分冬夏令）；运行环境不认、出错时当作取不到。
 * 按 at 那一刻的时区归属取（代码审查 11-05 第七节 M1）：原来用 formatToParts(0)，按 1970 年的归属说，
 * 基辅、里加、塔林、维尔纽斯、基希讷乌会说成“莫斯科标准时间”，加沙、希伯伦说成“以色列标准时间”，廷布说成“印度时间”；
 * Node 下 418 个时区有 162 个的 1970 年说法和现在不同。账号信是防钓鱼提醒，说错既不对也敏感。
 * 时刻由调用方传（A2：shared 里不取当前时间）；不传按 LABEL_REF_MS。邮件和恢复页都传注销时刻 ms，两边同一个口径。
 * 逐字一致只对固定表成立：表外时区走 Intl，说法跟着运行环境的 ICU 版本走（Deno 和浏览器的 ICU 不同就可能差一两个字）
 */
function intlGeneric(zone: string, loc: Locale, at: number): string {
  try {
    return new Intl.DateTimeFormat(loc, { timeZone: zone, timeZoneName: 'longGeneric' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** 时区名最长多少（profiles.current_tz 的上限同此；再长的不交给 Intl） */
const TZ_MAX_LEN = 64;

/**
 * 时区名校验加规范化（前后端共用，接手清单 KO-mail-tz-low L1）：Intl 认得就回它的规范名，不认得（非字符串、空串、过长、Intl 抛错）回 null。
 * • 大小写变体归一：asia/seoul、ASIA/SEOUL → Asia/Seoul（V8、WebKit 都会）；V8 另把 ROK → Asia/Seoul，PRC、Asia/Chongqing → Asia/Shanghai，
 *   Japan → Asia/Tokyo，utc、GMT → UTC。
 * • 别名怎么归一看内核，不一定是 IANA 现行名（11-05 实测）：
 *   - V8（Node 24.19、Deno 2.9.8、Chromium）：常见名一致，别名归到 ICU 规范名，Asia/Kolkata → Asia/Calcutta，Asia/Ho_Chi_Minh → Asia/Saigon；
 *     POSIX 风格的名字（EST5EDT、CST6CDT、MST7MDT、PST8PDT）因各端 ICU、tzdata 版本不同结果不一样（Node 归成 America/*，Chromium 原样返回），
 *     这类名字很少见，不进固定表（代码审查第七节 L2）；
 *   - WebKit（Playwright 自带 27.2）：只统一大小写（asia/seoul → Asia/Seoul），别名原样返回（ROK、US/Eastern、GB 都不变）。
 *   所以 fixedKey 里现行名和常见别名都要列全，不经规范化也能对上。
 * • 偏移写法（+09:00）Intl 也认，原样回；tzLabel 会退回这个字样（Intl 给的是 GMT+09:00，含拉丁字母）。
 */
export function canonicalTz(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > TZ_MAX_LEN) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** 时区的通俗说法：先规范化（大小写变体、别名对上固定表），再查写死的表，再按 Intl 取，都不行就是 IANA 名本身。zone 应已校验过（邮件经 safeTz） */
export const tzLabel: TzLabeler = (zone, loc, at = LABEL_REF_MS) => {
  const z = canonicalTz(zone) ?? zone;
  return fixedTzLabel(z, loc) ?? labelFromIntl(z, intlGeneric(z, loc, at));
};
