// 设置页在本机做的事（B1 K9）：记住界面语言（pv-locale + cookie lemo_lang），退出、被移除时给 platform/sign-out.ts 主 App 才有的几步
// 不变量：wipe 先占住“忙”（退出期间不 reload）、同步设闸，再 clearLocalData；清库出错照样抛，由 platform 当“库不能用”按库名删 planner-v4
// 不变量：deleteDb 先关本页连接再删（免得本页自己收到 versionchange 而 reload）；pendingCount 必须在 wipe 之前调
import { LANG_COOKIE, LOCALE_STORAGE_KEY, asLocale, type Locale, type UiLocale } from '../../../../shared/i18n/pick-locale.ts';
import { clearLocalData, closeCache, expireThisTab, markExpired, sealForExit } from '../../../core/account.ts';
import type { AuthLossSignal } from '../../../core/auth-loss.ts';
import { resolveAuthLossLazy } from '../../../core/auth-loss-lazy.ts';
import { applyFreshConfig, getBoot, localUnsentCount } from '../../../core/boot.ts';
import { goToAuth, readSessionUserId } from '../../../platform/session.ts';
import { defaultExitSteps, deleteLocalDb, type ExitSteps } from '../../../platform/sign-out.ts';

/** 本机记的语言；没记过、读不到（隐私模式）为 null */
export function readLocalLocale(storage?: Storage): Locale | null {
  try {
    return asLocale((storage ?? localStorage).getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** 记住本机的语言选择（写不进也不报错：这次照样切换，只是刷新后按设备语言） */
export function writeLocalLocale(locale: Locale, storage?: Storage, doc: Pick<Document, 'cookie'> = document): void {
  try {
    (storage ?? localStorage).setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // 同上
  }
  try {
    const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    doc.cookie = `${LANG_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  } catch {
    // 同上
  }
}

/**
 * 本机缓存的 profile（meta.profile）里的 ui_locale 跟着改：入口按“profiles.ui_locale → pv-locale → …”定语言（2.4 第 4 条），
 * 缓存里还是旧值的话，刷新后会被它盖回去。没有本机库、没缓存过 profile 时什么也不做
 */
export async function updateCachedLocale(ui: UiLocale): Promise<void> {
  const boot = getBoot();
  if (!boot?.profile) return;
  try {
    await applyFreshConfig(boot, { profile: { ...boot.profile, ui_locale: ui } });
  } catch {
    // 库已关闭：下次联网同步 profile 时会拿到服务器上的新值
  }
}

export interface ExitDeps extends ExitSteps {
  /** 本机会话里的 user_id（超时以后请求才回来时，判断旧会话有没有被写回） */
  readUserId(): string | null;
  /**
   * 还没上传的条数（core/boot 的 localUnsentCount）：先 refresh 读库（别的标签页刚写的也算），数离线队列全部项 + drafts +
   * vault_drafts + pending_actions；数不出来（没启动、库是 version_too_new / unavailable、已关闭、已封存、读失败）为 null。
   * 必须在 wipe 之前调
   */
  pendingCount(): Promise<number | null>;
  goToAuth(): void;
  /** 跳登录页失败时放开 wipe 占住的“忙”：库已因升级关掉的话，升级中心会自己重新载入页面 */
  releaseHold?(): void;
  /**
   * R-382（架构 4.1a 第 1 点 ②）：设置页的“被移除”先定结局。不给（测试）就照旧直接按被移除处理。
   * resolveAuthLoss：默认 core/auth-loss.ts 的；expireHere：登录过期时设闸、写 lemo.reauth、关库（false = 写不了记号，退回清库；
   *   marked：markHere 已写成记号，只关库、不写第二次）；
   * goToAuthExpired：回登录页提示“登录已过期”（只删那一个会话）；lostUserId：会话丢了的那个账号（本页启动时的账号）；
   * markHere：查 session_fate 之前先设闸、写 lemo.reauth（不关库；false = 写不了记号，直接按被移除清库），和别的出口的 markExpired 一样（独立验证建议 3）
   */
  resolveAuthLoss?(signal: AuthLossSignal): Promise<'expired' | 'removed'>;
  markHere?(sid: string | null): boolean;
  expireHere?(sid: string | null, marked?: boolean): boolean;
  goToAuthExpired?(sid: string | null): void;
  lostUserId?(): string | null;
}

/** wipe 里 holdBusy('sign_out') 的释放函数；退出期间不放，只在跳登录页失败时放 */
let releaseBusy: (() => void) | null = null;

export const defaultExitDeps: ExitDeps = {
  ...defaultExitSteps,
  wipe: async () => {
    const boot = getBoot();
    // 先占住“忙”、同步设闸，再清（被移除、自己退出两条路都走这里）；holdBusy 不释放
    if (boot) {
      releaseBusy = boot.upgrade.holdBusy('sign_out');
      sealForExit(boot);
    }
    const cache = boot?.cache;
    if (!cache || cache.isClosed() || boot.status !== 'ready') return false;
    // 上限、推送、运行时缓存、按库名删都在 platform/sign-out.ts 的 wipeThisDevice（只有那一层上限）；出错照样抛给它
    await clearLocalData(cache);
    return true;
  },
  deleteDb: async () => {
    try {
      getBoot()?.cache?.close();
    } catch {
      // 已经关了
    }
    return deleteLocalDb();
  },
  readUserId: () => readSessionUserId(),
  // 必须在 wipe（封存）之前调：封存以后 localUnsentCount 返回 null
  pendingCount: () => localUnsentCount(getBoot()),
  goToAuth,
  resolveAuthLoss: (signal) => resolveAuthLossLazy(signal),
  markHere: (sid) => {
    const boot = getBoot();
    return boot ? markExpired(boot, sid) : false;
  },
  expireHere: (sid, marked) => {
    const boot = getBoot();
    if (!boot) return false;
    if (!marked) return expireThisTab(boot, sid);
    closeCache(boot);
    return true;
  },
  goToAuthExpired: (sid) => goToAuth('expired', sid),
  lostUserId: () => getBoot()?.userId ?? null,
  releaseHold: () => {
    const r = releaseBusy;
    releaseBusy = null;
    r?.();
  },
};

/**
 * 本机缓存 meta 键 device 里记的设备行 id（core/device-reg.ts 登记的本会话 devices 行；导出时带给服务器，通知邮件写设备名）。
 * 没启动、库已关、还没登记、读失败都为 null（导出照样做，邮件写“未知设备”）
 */
export async function readLocalDeviceId(): Promise<string | null> {
  try {
    const cache = getBoot()?.cache;
    if (!cache || cache.isClosed()) return null;
    const rec = await cache.getMeta('device');
    return typeof rec?.id === 'string' ? rec.id : null;
  } catch {
    return null;
  }
}
