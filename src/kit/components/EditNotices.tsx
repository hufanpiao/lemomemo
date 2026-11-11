// 编辑页的保存状态文案、只读和删除提示只在这里做（架构 10.1）：待办、日程（EditShell）、随手记（自己的顶栏）三个编辑页共用，
// 词条在 shared/i18n/edit-zh.ts、edit-ko.ts；各页不同的“没写标题”“格式不对”两句由调用方传
import type { ReactNode } from 'react';
import { editKo } from '../../../shared/i18n/edit-ko.ts';
import { editZh, type EditMsgKey } from '../../../shared/i18n/edit-zh.ts';
import { Pressable } from '../../motion/components.ts';
import type { EditStatus } from '../hooks/useEditRecord.ts';
import { appUpdate } from '../hooks/useReadonly.ts';
import { makeUseT } from '../hooks/useT.ts';
import { FormButton } from './Form.tsx';

export const useEditT = makeUseT({ zh: editZh, ko: editKo });

const ST: Record<Exclude<EditStatus, 'empty_title' | 'rejected'>, EditMsgKey | null> = {
  idle: 'edit.st.idle',
  saving: 'edit.st.saving',
  saved: 'edit.st.saved',
  missing: 'edit.st.missing',
  local_unavailable: 'edit.st.unavailable',
  closing: 'edit.st.failed',
  switching: null,
  readonly: 'edit.st.readonly',
};
// “写上标题才会保存”（empty_title）是提示不是报错，用中性灰（负责人 11-06 真机截图 6：只选了日期就出红字，看着像报错）
const BAD: ReadonlySet<EditStatus> = new Set(['missing', 'local_unavailable', 'closing', 'readonly', 'rejected']);

/** 各页自己的两句：没写标题（empty_title）、格式不对（rejected） */
export interface OwnStatus {
  empty: string;
  rejected: string;
}

/** 保存状态那一句（switching 为空：页面马上跳走）和要不要标红 */
export function useEditStatus(status: EditStatus, own: OwnStatus): { text: string; bad: boolean } {
  const t = useEditT();
  const key = status === 'empty_title' || status === 'rejected' ? null : ST[status];
  const text = status === 'empty_title' ? own.empty : status === 'rejected' ? own.rejected : key ? t(key, {}) : '';
  return { text, bad: BAD.has(status) };
}

/** 只读行的一句话加“更新”（EditShell 顶部的浅灰条；随手记编辑器自己的提示行也用这两样） */
export function ReadonlyNotice({ testId, plain = false }: { testId: string; plain?: boolean }): ReactNode {
  const t = useEditT();
  return (
    <>
      <span>{t('edit.st.readonly', {})}</span>
      {plain ? (
        <button type="button" onClick={appUpdate} data-testid={testId}>
          {t('edit.update', {})}
        </button>
      ) : (
        <Pressable onClick={appUpdate} data-testid={testId}>
          {t('edit.update', {})}
        </Pressable>
      )}
    </>
  );
}

/** “已删除。30 天内可以在‘最近删除’里找回。”加“撤销” */
export function DeletedNotice({ onUndo, testId }: { onUndo(): void; testId: string }): ReactNode {
  const t = useEditT();
  return (
    <>
      {t('edit.deleted', {})}{' '}
      <FormButton onClick={onUndo} data-testid={testId}>
        {t('edit.undo', {})}
      </FormButton>
    </>
  );
}
