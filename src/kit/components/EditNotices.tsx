// 编辑页的保存状态文案、只读和删除提示只在这里做（架构 10.1）：待办、日程（EditShell）、随手记（自己的顶栏）三个编辑页共用，
// 词条在 shared/i18n/edit-zh.ts、edit-ko.ts；各页不同的“没写标题”“格式不对”两句由调用方传
import type { ReactNode } from 'react';
import { editKo } from '../../../shared/i18n/edit-ko.ts';
import { editZh, type EditMsgKey } from '../../../shared/i18n/edit-zh.ts';
import { Pressable } from '../../motion/components.ts';
import type { EditStatus } from '../hooks/useEditRecord.ts';
import { appUpdate } from '../hooks/useReadonly.ts';
import { useRoT } from '../hooks/useRoT.ts';
import { makeUseT } from '../hooks/useT.ts';
import { FormButton } from './Form.tsx';
import ro from './ReadonlyRow.module.css';

export const useEditT = makeUseT({ zh: editZh, ko: editKo });

const ST: Record<Exclude<EditStatus, 'empty_title' | 'rejected'>, EditMsgKey | null> = {
  idle: 'edit.st.idle',
  saving: 'edit.st.saving',
  saved: 'edit.st.saved',
  missing: 'edit.st.missing',
  local_unavailable: 'edit.st.unavailable',
  closing: 'edit.st.failed',
  quota: 'edit.st.failed',
  switching: null,
  readonly: 'edit.st.readonly',
};
// “写上标题才会保存”（empty_title）是提示不是报错，用中性灰（负责人 11-06 真机截图 6：只选了日期就出红字，看着像报错）
const BAD: ReadonlySet<EditStatus> = new Set(['missing', 'local_unavailable', 'closing', 'quota', 'readonly', 'rejected']);

/** 各页自己的两句：没写标题（empty_title）、格式不对（rejected） */
export interface OwnStatus {
  empty: string;
  rejected: string;
}

/** 保存状态那一句（switching 为空：页面马上跳走）和要不要标红 */
export function useEditStatus(status: EditStatus, own: OwnStatus): { text: string; bad: boolean } {
  const t = useEditT();
  const msg = (k: EditMsgKey | null): string => (k ? t(k, {}) : '');
  const text = status === 'empty_title' ? own.empty : status === 'rejected' ? own.rejected : msg(ST[status]);
  return { text, bad: BAD.has(status) };
}

/**
 * 只读提示整条“这条要新版本才能修改 · 更新”：中性浅灰条（ReadonlyRow.module.css 的 .banner，和今天页、日历页的重复事项横幅同一套），
 * 调用方只给 role、测试 id 和外边距（className）。
 * plain：随手记编辑页的“更新”一直是原生按钮、没有按下反馈；待办、日程编辑页是 Pressable（按下缩一下）。
 * 统一成一种会改其中一边的手感，没有定，先照原样保留两种
 */
export function ReadonlyNotice({ role, testId, updateTestId, className, plain = false }: { role: 'alert' | 'status'; testId: string; updateTestId: string; className: string | undefined; plain?: boolean }): ReactNode {
  const t = useEditT();
  const tRo = useRoT();
  const label = tRo('ro.update', {});
  return (
    <p className={`${ro.banner} ${className ?? ''}`} role={role} data-testid={testId}>
      <span className={ro.text}>{t('edit.st.readonly', {})}</span>
      {plain ? (
        <button type="button" className={ro.update} onClick={appUpdate} data-testid={updateTestId}>
          {label}
        </button>
      ) : (
        <Pressable className={ro.update} onClick={appUpdate} data-testid={updateTestId}>
          {label}
        </Pressable>
      )}
    </p>
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
