// 编辑页外框（B2 FA-2）：顶栏“‹ 返回 · 类型名 · 保存状态”、顶部提示（只读、已删除）、正文、底部“删除”。保存状态、只读、删除按 useEditRecord 画（EditNotices.tsx），表单内容由调用方传
// 保存状态是常驻的 role="status"，读屏会播报“已自动保存”“没保存上”
// 编辑页挂着期间占住升级中心的 busy（BUSY-wire）：不出版本横幅、不自动重新载入，离开编辑页就释放
import type { ReactNode } from 'react';
import type { EditRecord } from '../hooks/useEditRecord.ts';
import { useHoldBusy } from '../hooks/useHoldBusy.ts';
import { BackLink } from './BackLink.tsx';
import { DeletedNotice, ReadonlyNotice, useEditStatus, useEditT, type OwnStatus } from './EditNotices.tsx';
import styles from './EditShell.module.css';
import { FormButton } from './Form.tsx';

export interface EditShellProps {
  kind: string;
  backLabel: string;
  onBack(): void;
  /** 这一页的记录（useEditRecord）：保存状态、只读、删除和撤销都按它画 */
  rec: Pick<EditRecord<unknown>, 'row' | 'status' | 'readonly' | 'deleted' | 'setDeleted'>;
  /** 各页自己的“没写标题”“格式不对” */
  own: OwnStatus;
  /** 页面和按钮的测试 id 前缀（todo-edit、event-edit） */
  prefix: string;
  children: ReactNode;
}

export function EditShell({ kind, backLabel, onBack, rec, own, prefix, children }: EditShellProps) {
  useHoldBusy('editing');
  const t = useEditT();
  const st = useEditStatus(rec.status, own);
  const { readonly, deleted } = rec;
  const del = (v: boolean) => void rec.setDeleted(v);
  return (
    <main className={styles.page} data-testid={prefix}>
      <div className={styles.top}>
        <BackLink label={backLabel} onBack={onBack} testId="edit-back" />
        <h1 className={styles.kind}>{kind}</h1>
        {/* 只读时不写“改了就自动保存”（FA-2 视觉验收第 2 条） */}
        <p className={`${styles.status}${st.bad ? ` ${styles.statusBad}` : ''}`} role="status" data-testid="edit-status">
          {rec.status !== 'idle' || !readonly ? st.text : ''}
        </p>
      </div>
      {/* 只读：中性浅灰条（quiet，和今天页、日历页的重复事项横幅同款）；已删除：红条 */}
      {readonly || deleted ? (
        <p className={styles.notice} data-tone={readonly ? 'quiet' : undefined} role="alert" data-testid="edit-notice">
          {readonly ? <ReadonlyNotice testId={`${prefix}-update`} /> : <DeletedNotice onUndo={() => del(false)} testId={`${prefix}-undo`} />}
        </p>
      ) : null}
      {children}
      {rec.row && !deleted && !readonly ? (
        <div className={styles.actions}>
          <FormButton danger onClick={() => del(true)} data-testid={`${prefix}-delete`} data-no-proxy="">
            {t('edit.delete', {})}
          </FormButton>
        </div>
      ) : null}
    </main>
  );
}
