// sync-notice 的 t()（K8 冲突提示）：词典在 ../i18n/zh.ts、ko.ts，语言跟着 ui-store 的 locale（写法同 reminders 的 useRemindT）
import { createT } from '../../../../shared/i18n/i18n.ts';
import { syncNoticeKo } from '../i18n/ko.ts';
import { syncNoticeZh } from '../i18n/zh.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';

export type SnKey = keyof typeof syncNoticeZh & string;

export const tSn = createT({ zh: syncNoticeZh, ko: syncNoticeKo });

export const useSnT = makeUseT({ zh: syncNoticeZh, ko: syncNoticeKo });

export type SnT = ReturnType<typeof useSnT>;
