// 网页版宽屏今天页的词典钩子（i18n/desk-*.ts）：TodayDesk.tsx、SoonCard.tsx 共用，跟着它们按需下载，不进首屏
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { todayDeskKo } from '../i18n/desk-ko.ts';
import { todayDeskZh } from '../i18n/desk-zh.ts';

export const useTodayDeskT = makeUseT({ zh: todayDeskZh, ko: todayDeskKo });
