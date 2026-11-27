// 设置页在本机做的事：记住界面语言（pv-locale + cookie lemo_lang），本人退出时给 platform/sign-out.ts 主 App 才有的几步
// 不变量：wipe 先占住“忙”（退出期间不 reload），再走 core/account.ts 的 bootWipeSteps（清库，闸在 beginExit 设；deleteDb 先关本页连接再按库名删），
// 和会话没了、被移除那几条出口是同一份；pendingCount 必须在 wipe 之前调
// 会话不认、本机没有会话不经这里：useSettingsPage 交给 core/device-exit.ts 的 exitDevice
import { LANG_COOKIE, LOCALE_STORAGE_KEY, type LangCode, type UiLocale } from '../../../../shared/i18n/pick-locale.ts';
import { bootWipeSteps } from '../../../core/account.ts';
import { beginExit } from '../../../core/device-exit.ts';
import { applyFreshConfig, getBoot, localUnsentCount } from '../../../core/boot.ts';
import { goToAuth, readSessionUserId } from '../../../platform/session.ts';
import { defaultExitSteps, type ExitSteps } from '../../../platform/sign-out.ts';
import { deleteLocalDb } from '../../../platform/exit-basics.ts';

/** 记住本机的语言选择（写不进也不报错：这次照样切换，只是刷新后按设备语言）；读回来定语言只在 platform/doc-locale.ts 的 bootLocale */
export function writeLocalLocale(locale: LangCode, storage?: Storage, doc: Pick<Document, 'cookie'> = document): void {
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
 * 本机缓存的 profile（meta.profile）里的 ui_locale 跟着改：入口按“profiles.ui_locale → pv-locale → …”定语言，
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

export interface SignOutHereDeps extends ExitSteps {
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
  /** 发任何请求之前登记“这一页开始退出”并设闸（默认 core/device-exit.ts 的 beginExit） */
  beginExit(): void;
}

/** wipe 里 holdBusy('sign_out') 的释放函数；退出期间不放，只在跳登录页失败时放 */
let releaseBusy: (() => void) | null = null;

export const defaultSignOutHereDeps: SignOutHereDeps = {
  ...defaultExitSteps,
  wipe: async () => {
    const boot = getBoot();
    if (!boot) return;
    // 先占住“忙”，再清（闸已由 beginExit 设好；上限、推送、运行时缓存、按库名删都在 wipeThisDevice）；holdBusy 不释放
    releaseBusy = boot.upgrade.holdBusy('sign_out');
    await bootWipeSteps(boot).wipe();
  },
  deleteDb: () => {
    const boot = getBoot();
    return boot ? bootWipeSteps(boot).deleteDb() : deleteLocalDb();
  },
  readUserId: () => readSessionUserId(),
  // 必须在 wipe（封存）之前调：封存以后 localUnsentCount 返回 null
  pendingCount: () => localUnsentCount(getBoot()),
  goToAuth,
  beginExit: () => beginExit(getBoot()),
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
