// 中韩切换（架构 2.4 第 4 条、16.4；TC-B1-19）
// 点一下：界面立刻换（ui-store 的 locale，用到 t() 的组件全部重画）、<html lang> 跟着换、本机记下（pv-locale、cookie），
// 再写账号：profiles.ui_locale（推送文案）和 user_metadata.locale（邮件模板）。账号写不进不回滚界面，只提示一句
import { useCallback, useState } from 'react';
import { toUiLocale, type Locale } from '../../../../shared/i18n/pick-locale.ts';
import { uiStore, useUi } from '../../../kit/state/ui-store.ts';
import { updateCachedLocale, writeLocalLocale } from '../data/local.ts';
import type { SettingsApi } from '../data/settings-api.ts';

export type LocaleSyncState = 'idle' | 'saving' | 'failed';

/** 把语言用到这一页（ui-store、<html lang>）并记在本机（pv-locale、cookie、缓存的 profile）；刷新后由入口按它恢复 */
export function applyLocale(locale: Locale): void {
  const ui = toUiLocale(locale);
  uiStore.getState().setLocale(ui);
  document.documentElement.lang = ui;
  writeLocalLocale(locale);
  void updateCachedLocale(ui);
}

export function useLocaleSwitch(
  api: SettingsApi,
  onRevoked: (sid: string | null) => void,
  onSignedOut: (sid: string | null) => void,
  /** account_disabled：先探测再定是否离开（R-256 ③）；不给就只提示失败 */
  onDisabled?: (sid: string | null) => void,
) {
  const current: Locale = useUi((s) => (s.locale === 'ko-KR' ? 'ko' : 'zh'));
  const [sync, setSync] = useState<LocaleSyncState>('idle');

  const choose = useCallback(
    async (locale: Locale) => {
      if (locale === current) return;
      applyLocale(locale);
      setSync('saving');
      const r = await api.saveLocale(toUiLocale(locale));
      if (r.ok) {
        setSync('idle');
        return;
      }
      if (r.error === 'revoked') onRevoked(r.sid);   // 被拒那次请求用的会话（K6-sugg4 ①）
      else if (r.error === 'signed_out') onSignedOut(r.sid);
      else if (r.error === 'account_disabled') onDisabled?.(r.sid);
      setSync('failed');
    },
    [api, current, onRevoked, onSignedOut, onDisabled],
  );

  return { current, sync, choose };
}
