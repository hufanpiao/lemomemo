// 中韩切换（架构 2.4 第 4 条、16.4；TC-B1-19）
// 点一下：界面立刻换（ui-store 的 locale，用到 t() 的组件全部重画）、<html lang> 跟着换、本机记下（pv-locale、cookie），
// 再写账号：profiles.ui_locale（推送文案）和 user_metadata.locale（邮件模板）。账号写不进不回滚界面，只提示一句
// 公共词典只下载了当前语言那一份（首屏瘦身 D，11-17）：先等新语言那份下载好再换，换之前一直显示原来的语言，不出空白和键名；
// 已经下载过就当场换。下载失败（离线又没有缓存）不换，提示一句没保存上
// 连点（独立评审 11-17 第 4 条）：wanted 记着正在等词典的那次点的语言——下载中点回原来的语言就作废那一次（回来时对不上就放弃）；
// 下载中再点同一种语言不重复保存；比较“现在是哪种语言”读 ui-store 当前值，不用渲染时的旧值
import { useCallback, useRef, useState } from 'react';
import { fromUiLocale, toUiLocale, type LangCode } from '../../../../shared/i18n/pick-locale.ts';
import { uiStore, useUi } from '../../../kit/state/ui-store.ts';
import { applyUiLocale, loadSharedDict } from '../../../platform/doc-locale.ts';
import { updateCachedLocale, writeLocalLocale } from '../data/local.ts';
import type { SettingsApi } from '../data/settings-api.ts';

export type LocaleSyncState = 'idle' | 'saving' | 'failed';

/** 把语言用到这一页（platform/doc-locale.ts 的 applyUiLocale：ui-store、<html lang>、页面标题）并记在本机（pv-locale、cookie、缓存的 profile）；刷新后由入口按它恢复 */
export function applyLocale(locale: LangCode): void {
  const ui = toUiLocale(locale);
  applyUiLocale(ui, uiStore.getState());
  writeLocalLocale(locale);
  void updateCachedLocale(ui);
}

const shownLocale = (): LangCode => fromUiLocale(uiStore.getState().locale);

export function useLocaleSwitch(
  api: SettingsApi,
  onRevoked: (sid: string | null) => void,
  onSignedOut: (sid: string | null) => void,
  /** account_disabled：先探测再定是否离开（R-256 ③）；不给就只提示失败 */
  onDisabled?: (sid: string | null) => void,
) {
  const current: LangCode = useUi((s) => fromUiLocale(s.locale));
  const [sync, setSync] = useState<LocaleSyncState>('idle');
  /** 正在等词典下载的那次点的语言；null 是没有在等 */
  const wanted = useRef<LangCode | null>(null);

  const choose = useCallback(
    async (locale: LangCode) => {
      if (wanted.current === locale) return;   // 这种语言的词典已经在下载：那一次下载完会接着换、保存
      if (locale === shownLocale()) {
        // 下载中点回原来的语言：作废那一次，“保存中”收掉
        if (wanted.current !== null) {
          wanted.current = null;
          setSync('idle');
        }
        return;
      }
      const dict = loadSharedDict(toUiLocale(locale));
      if (dict) {
        wanted.current = locale;
        setSync('saving');
        try {
          await dict;
        } catch {
          if (wanted.current === locale) {
            wanted.current = null;
            setSync('failed');
          }
          return;
        }
        if (wanted.current !== locale) return;   // 下载期间点回了原来的语言
        wanted.current = null;
      }
      applyLocale(locale);
      setSync('saving');
      const r = await api.saveLocale(toUiLocale(locale));
      // 保存期间又换了语言：这一次的结果不再改提示（会话失效那几种照样处理）
      const latest = wanted.current === null && shownLocale() === locale;
      if (r.ok) {
        if (latest) setSync('idle');
        return;
      }
      if (r.error === 'revoked') onRevoked(r.sid);   // 被拒那次请求用的会话（K6-sugg4 ①）
      else if (r.error === 'signed_out') onSignedOut(r.sid);
      else if (r.error === 'account_disabled') onDisabled?.(r.sid);
      if (latest) setSync('failed');
    },
    [api, onRevoked, onSignedOut, onDisabled],
  );

  return { current, sync, choose };
}
