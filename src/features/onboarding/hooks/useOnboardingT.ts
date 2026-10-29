// 功能 onboarding 自己的 t()（架构 2.4）：词典在 ../i18n/，语言跟着 ui-store 的 locale（和 auth 的 useAuthT 同一个写法）
import { useCallback } from 'react';
import { createT, type ParamsOf } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

export type OnboardingMsgKey = keyof typeof zh & string;

const tOnboarding = createT({ zh, ko });

export function useOnboardingT() {
  const locale = useUi((s) => s.locale);
  return useCallback(
    <K extends OnboardingMsgKey>(key: K, params: ParamsOf<typeof zh, K>): string => tOnboarding(key, params, locale),
    [locale],
  );
}
