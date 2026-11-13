// 隐私记会话的钩子（B5 FA-1）：整个 App 一份会话（data/session.ts），页面、随手记里的入口行和“移到隐私记”、设置 › 隐私记共用
// • 会话第一次用到时才建（vault 块懒加载，不进首屏）；同时挂上离开、回来的监听（S6）：
//   - visibilitychange → hidden、pagehide、blur：**同步**给 <html> 加 data-vault-shield="1"（LockShield 立刻盖上，不做动效，S21），记下离开时刻
//   - visibilitychange → visible、pageshow、focus：离开满 vault.autolock_min 分钟就上锁；然后去掉遮罩（锁上了就露出解锁卡）
// • 自动上锁的分钟数读本机 settings 的 vault.autolock_min（默认 1；只认 1～60 的整数）
import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { addDays, todayOf } from '../../../../shared/core/date.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { fmtDate, fmtTime } from '../../../../shared/i18n/fmt.ts';
import { categoryNameOf } from '../../../core/categories.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { settingValue, type SettingRow } from '../../../core/setting-read.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { holdReducedTransparency } from '../../../platform/look.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { createVaultApi } from '../data/vault-api.ts';
import { createVaultSession, type VaultSession, type VaultState } from '../data/session.ts';
import { vaultErrorAction, type VaultCode } from '../data/vault-errors.ts';
import { useVaultT } from './useVaultT.ts';

export const AUTOLOCK_KEY = 'vault.autolock_min';
export const AUTOLOCK_DEFAULT = 1;
export const AUTOLOCK_CHOICES = [1, 5, 15] as const;
export const SHIELD_ATTR = 'data-vault-shield';

export function autolockOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 60 ? v : AUTOLOCK_DEFAULT;
}

let session: VaultSession | null = null;
let autolockMin = AUTOLOCK_DEFAULT;

/** 盖上 / 去掉多任务遮罩（同步改 DOM，不等 React 渲染） */
export function setShield(on: boolean, root: HTMLElement = document.documentElement): void {
  if (on) root.setAttribute(SHIELD_ATTR, '1');
  else root.removeAttribute(SHIELD_ATTR);
}

/** 离开、回来的监听（导出给测试：注入会话、时钟、目标） */
export function watchLeave(s: VaultSession, target: Window & typeof globalThis = window, now: () => number = () => Date.now()): () => void {
  const doc = target.document;
  const leave = (): void => {
    setShield(true, doc.documentElement);
    s.hide(now());
  };
  const back = (): void => {
    if (doc.visibilityState === 'hidden') return;
    s.show(now(), autolockMin);
    setShield(false, doc.documentElement);
  };
  const vis = (): void => (doc.visibilityState === 'hidden' ? leave() : back());
  doc.addEventListener('visibilitychange', vis);
  target.addEventListener('pagehide', leave);
  target.addEventListener('blur', leave);
  target.addEventListener('pageshow', back);
  target.addEventListener('focus', back);
  return () => {
    doc.removeEventListener('visibilitychange', vis);
    target.removeEventListener('pagehide', leave);
    target.removeEventListener('blur', leave);
    target.removeEventListener('pageshow', back);
    target.removeEventListener('focus', back);
  };
}

/** 隐私记页挂着时底栏和“＋”实色（TC-B5-12）：走 platform/look.ts 的同一个 data-rt 判断，卸掉时放开 */
export function useSolidBars(): void {
  useLayoutEffect(() => holdReducedTransparency(), []);
}

/** 整个 App 一份会话；测试可以先 installVaultSession 换成桩 */
export function vaultSession(): VaultSession {
  if (!session) {
    session = createVaultSession({ api: createVaultApi(getSupabase) });
    if (typeof window !== 'undefined') watchLeave(session);
  }
  return session;
}

export function installVaultSession(s: VaultSession | null): void {
  session = s;
}

export function useVault(): { state: VaultState; s: VaultSession } {
  const s = vaultSession();
  const state = useSyncExternalStore(s.subscribe, s.get, s.get);
  return { state, s };
}

/** 读自动上锁分钟数，并告诉会话（离开、回来时按它判断） */
export function useAutolockMin(): number {
  const rows = useCollection<SettingRow>('settings');
  const min = autolockOf(settingValue(rows, AUTOLOCK_KEY));
  useEffect(() => {
    autolockMin = min;
  }, [min]);
  return min;
}

/**
 * 隐私记有几条（锁着也能数）：本机 notes 集合里 is_private 的行只有密文列和中性列（0.27 第 1 点），数行数不碰明文；
 * 解锁以后以内存里的明文列表为准
 */
export function useVaultCount(): number {
  const rows = useCollection<{ id: string; is_private?: unknown; deleted_at?: unknown; undone?: unknown }>('notes');
  const { state } = useVault();
  if (state.notes) return state.notes.filter((n) => n.deleted_at === null).length;
  return rows.filter((r) => r.is_private === true && isLiveRow(r)).length;
}

/** 第一次打开时查一次状态（设没设过、是不是锁定中、绑了几个 Face ID） */
export function useVaultStatus(): VaultState {
  const { state, s } = useVault();
  useEffect(() => {
    if (state.phase === 'loading' || state.status === null) void s.refreshStatus();
    // 只在挂上时查；之后的状态由各个动作更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s]);
  return state;
}

export type { VaultCode } from '../data/vault-errors.ts';

/** 失败码 → 一句提示（落法见 data/vault-errors.ts 的穷尽 switch） */
export function useErrText(): (code: VaultCode | null) => string {
  const t = useVaultT();
  return (code) => (code ? t(vaultErrorAction(code).msg, {}) : '');
}

/** 时刻 → “11月14日 21:05”（按 profiles.current_tz；设置 › 隐私记“上次重设”用） */
export function useFmtAt(): (ms: number) => string {
  const locale = useUi((u) => u.locale);
  return (ms) => {
    const tz = currentTz();
    return `${fmtDate(ms, tz, locale, 'monthDay')} ${fmtTime(ms, tz)}`;
  };
}

/**
 * 解锁后列表一行的日期和分类名（线框 s9 PRIVLIST：“昨天”“10/20”、灰字分类）：
 * 日期按当前时区，今天写时刻、昨天写“昨天”、更早写“月/日”；分类顺着合并归到留下的那个（core/categories.ts，同随手记）
 */
export function useVaultRowMeta(): { dayOf(ms: number): string; catOf(id: string | null): string | null } {
  const t = useVaultT();
  const now = useMinuteNow();
  const tz = currentTz();
  const catOf = categoryNameOf(useCollection('categories'));
  return {
    dayOf(ms) {
      const d = todayOf(ms, tz);
      const today = todayOf(now, tz);
      if (d === today) return fmtTime(ms, tz);
      if (d === addDays(today, -1)) return t('vault.list.yesterday', {});
      const [, m = '', day = ''] = d.split('-');
      return t('vault.list.md', { m: Number(m), d: Number(day) });
    },
    catOf,
  };
}
