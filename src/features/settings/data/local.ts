// 设置页在本机做的事（B1 K9）：记住界面语言、退出时清空本机
// • 语言（架构 2.4 第 4 条、16.4）：写 localStorage 的 pv-locale（App 和登录页启动时按它定语言），
//   再写 cookie lemo_lang（官网首页 / 按它跳 /zh/ 或 /ko/，和首页页脚的手动切换同一写法）
// • 退出本机、被移除、被退出（4.1、0.29 续第 98 条）：清空整个本机库和 Cache Storage，再清本机会话；
//   localStorage 里的 install_id、pv-locale 不清；之后回登录页
//   - 本机库：先 core/account 的 sealForExit 同步设闸（switching、outbox 暂停、库封存，不可解除；之后 K8 不再发送、
//     ack / fail 不再写库，只有 clearAll 能写），再 core/boot 的 wipeLocal（clearAll + 清内存集合）；库已关闭、打不开、来自更新的版本时直接 indexedDB.deleteDatabase('planner-v4') 兜底；
//     每一步都设上限（K9 第二轮 N1、N2：网络或别的标签页卡住时不能一直等）
//   - 本机会话：先 auth.signOut({scope: 'local'})（settings-api），不是 ok 就用 platform/session.ts 的 clearLocalSession()
//     删 sb-*-auth-token 和 sb-*-auth-token-code-verifier 兜底
import { LANG_COOKIE, LOCALE_STORAGE_KEY, asLocale, type Locale, type UiLocale } from '../../../../shared/i18n/pick-locale.ts';
import { sealForExit } from '../../../core/account.ts';
import { applyFreshConfig, getBoot, localUnsentCount, wipeLocal } from '../../../core/boot.ts';
import { DB_NAME } from '../../../core/cache.ts';
import { clearCacheStorage, clearLocalSession, goToAuth, readSessionUserId } from '../../../platform/session.ts';
import { withTimeout } from './timeout.ts';

/** 清本机库最多等多久（超时改走直接删库，删库本身另有 3 秒上限） */
export const WIPE_TIMEOUT_MS = 3000;
/** 清 Cache Storage 最多等多久 */
export const CACHES_TIMEOUT_MS = 2000;

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

/** 直接删本机库（库不能用时的兜底）；永远 resolve，最多等 waitMs（别的标签页还开着库时浏览器会等它关） */
export function deleteLocalDb(factory: IDBFactory | undefined = globalThis.indexedDB, waitMs = 3000): Promise<void> {
  if (!factory) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    try {
      const req = factory.deleteDatabase(DB_NAME);
      req.onsuccess = done;
      req.onerror = done;
    } catch {
      done();
    }
  });
}

export interface ExitDeps {
  /** 清空本机库和内存集合 */
  wipe(): Promise<void>;
  clearCacheStorage(): Promise<void>;
  /** 服务器退出不是 ok 时兜底删本机会话 */
  clearLocalSession(): void;
  /** 本机会话里的 user_id（超时以后请求才回来时，判断旧会话有没有被写回） */
  readUserId(): string | null;
  /**
   * 还没上传的条数（core/boot 的 localUnsentCount）：先 refresh 读库（别的标签页刚写的也算），数离线队列全部项 + drafts +
   * vault_drafts + pending_actions；数不出来（没启动、库是 version_too_new / unavailable、已关闭、已封存、读失败）为 null。
   * 必须在 wipe 之前调
   */
  pendingCount(): Promise<number | null>;
  goToAuth(): void;
}

export const defaultExitDeps: ExitDeps = {
  wipe: async () => {
    const boot = getBoot();
    // 先同步设闸，再清（被移除、自己退出两条路都走这里）
    if (boot) sealForExit(boot);
    const cache = boot?.cache;
    if (cache && !cache.isClosed() && boot.status === 'ready') {
      await wipeLocal(cache);
      return;
    }
    // 没启动、库已关闭、打不开、来自更新的版本：整个库删掉
    await deleteLocalDb();
  },
  clearCacheStorage,
  clearLocalSession: () => clearLocalSession(),
  readUserId: () => readSessionUserId(),
  // 必须在 wipe（封存）之前调：封存以后 localUnsentCount 返回 null
  pendingCount: () => localUnsentCount(getBoot()),
  goToAuth,
};

/** 清空本机（库、Cache Storage）；某一步失败或超时不挡后面的步骤，永远 resolve */
export async function wipeThisDevice(deps: Pick<ExitDeps, 'wipe' | 'clearCacheStorage'>, wipeMs = WIPE_TIMEOUT_MS, cachesMs = CACHES_TIMEOUT_MS): Promise<void> {
  const wiped = await withTimeout(
    async () => {
      await deps.wipe();
      return true;
    },
    wipeMs,
    () => false,
  );
  if (!wiped) {
    try {
      await deleteLocalDb();
    } catch {
      // 同下
    }
  }
  await withTimeout(
    async () => {
      await deps.clearCacheStorage();
      return true;
    },
    cachesMs,
    () => false,
  );
}
