// 功能 ai-provider 自己的 t()：词典在 ../i18n/，语言跟着 ui-store 的 locale；
// 另带几样界面要的拼字：服务商显示名、几项用途连成一句（“对话和整理、录音转文字”）
import { useCallback } from 'react';
import type { KeyOwnerName } from '../../../../shared/schema/ai-provider.ts';
import type { AdminRow } from '../data/rules.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { AI_PROVIDER_LABEL } from '../index.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

export type AipMsgKey = keyof typeof zh & string;

export const useAipT = makeUseT({ zh, ko });

export const labelOf = (p: KeyOwnerName): string => AI_PROVIDER_LABEL[p];

/** 联网那一行的值：勾的几家用 + 连（“DeepSeek + Brave”；品牌名中韩一样） */
export const webLabelOf = (picks: readonly KeyOwnerName[]): string => picks.map(labelOf).join(' + ');

/** 几项用途连成一句：kind 选用哪一套叫法（task 管理员页和“谁做什么”；cover 切换前提示第一条；rest 第二条） */
export function useTaskList(): (tasks: readonly AdminRow[], kind: 'task' | 'cover' | 'rest') => string {
  const t = useAipT();
  return useCallback((tasks, kind) => tasks.map((k) => t(`aip.${kind}.${k}`, {})).join(t('aip.list', {})), [t]);
}
