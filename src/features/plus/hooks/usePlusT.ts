// 功能 plus 自己的 t()（架构 2.4）：词典在 ../i18n/，语言跟着 ui-store 的 locale
import { useCallback } from 'react';
import { fill } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';

export type PlusMsgKey = keyof typeof zh & string;

export const usePlusT = makeUseT({ zh, ko });

/** 参数在运行时才定的词条（提示条的几行，data/notice.ts 给 key 和参数）：直接查词典再填参数，不用 as */
export function usePlusLine() {
  const locale = useUi((s) => s.locale);
  return useCallback(
    (key: PlusMsgKey, params: Readonly<Record<string, string | number>>): string => fill(locale === 'ko-KR' ? ko[key] : zh[key], params),
    [locale],
  );
}

/** 手机自带识别听哪种话（lang，跟界面语言）、另一种是什么（other）：录音面板、提示条共用这一份 */
export function useLangNames(): { lang: string; other: string } {
  const t = usePlusT();
  const ko = useUi((s) => s.locale) === 'ko-KR';
  return { lang: t(ko ? 'plus.lang.ko' : 'plus.lang.zh', {}), other: t(ko ? 'plus.lang.zh' : 'plus.lang.ko', {}) };
}
