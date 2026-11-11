// 设置页在本机做的事（B1 K9）：记住界面语言、退出时清空本机
// • 语言（架构 2.4 第 4 条、16.4）：写 localStorage 的 pv-locale（App 和登录页启动时按它定语言），
//   再写 cookie lemo_lang（官网首页 / 按它跳 /zh/ 或 /ko/，和首页页脚的手动切换同一写法）
// • 退出本机、被移除、被退出（4.1、0.29 续第 98 条）：流程在 platform/sign-out.ts（和登录页共用，K-signout-merge）；
//   这里只给主 App 才有的一步 wipe：先 core/account 的 sealForExit 同步设闸（switching、outbox 暂停、库封存，不可解除；
//   之后 K8 不再发送、ack / fail 不再写库，只有 clearAll 能写），再 core/account 的 wipeLocal（清库、清内存集合、关库；推送和运行时缓存由 platform 清）；
//   库不能用（没启动、已关、打不开、来自更新的版本）时返回 false，由 platform 按库名删 planner-v4
//   - 退出期间不能 reload（K-signout-merge 复审 M1）：按库名删库会给本页还开着的连接发 versionchange → core 关库 → 升级中心 reload，
//     打断后面的 signOut，留下“有会话、没库”。所以 ① wipe 一开头 upgrade.holdBusy('sign_out')，退出期间不释放（最后 goToAuth 离开页面）；
//     ② deleteDb 先 close() 本页连接（原因是 'closed'，不触发 reload）再删
import { LANG_COOKIE, LOCALE_STORAGE_KEY, asLocale, type Locale, type UiLocale } from '../../../../shared/i18n/pick-locale.ts';
import { expireThisTab, markExpired, sealForExit, wipeLocal } from '../../../core/account.ts';
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
   * resolveAuthLoss：默认 core/auth-loss.ts 的；expireHere：登录过期时设闸、写 lemo.reauth、关库（false = 写不了记号，退回清库）；
   * goToAuthExpired：回登录页提示“登录已过期”（只删那一个会话）；lostUserId：会话丢了的那个账号（本页启动时的账号）；
   * markHere：查 session_fate 之前先设闸、写 lemo.reauth（不关库；false = 写不了记号，直接按被移除清库），和别的出口的 markExpired 一样（独立验证建议 3）
   */
  resolveAuthLoss?(signal: AuthLossSignal): Promise<'expired' | 'removed'>;
  markHere?(sid: string | null): boolean;
  expireHere?(sid: string | null): boolean;
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
    // 推送、运行时缓存由 platform/sign-out.ts 的 wipeThisDevice 接着清，这里不重复
    await wipeLocal(boot, { clearCacheStorage: () => Promise.resolve(), disconnectPush: () => Promise.resolve() });
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
  expireHere: (sid) => {
    const boot = getBoot();
    return boot ? expireThisTab(boot, sid) : false;
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
