// 编辑页外框（B2 FA-2）：顶栏“‹ 返回 · 类型名 · 保存状态”、顶部提示（只读、已删除）、正文、底部“删除”。保存状态、只读、删除按 useEditRecord 画（EditNotices.tsx），表单内容由调用方传
// 保存状态是常驻的 role="status"，读屏会播报“已自动保存”“没保存上”
// 编辑页挂着期间占住升级中心的 busy（BUSY-wire）：不出版本横幅、不自动重新载入，离开编辑页就释放；放在详情抽屉里时不在这里占，
// 由 DetailDrawer 按焦点在不在抽屉里占（抽屉在电脑上可能开一整天，B6 独立评审第 12 条）
// 电脑版今天页的详情抽屉（B6 返工，线框 s1“选中一条：详情抽屉从右边盖上来”）也用它：在抽屉里（kit DetailDrawer 的 useInDrawer）就不画“‹ 返回”，顶行是“类型名 · 保存状态 · ×”，外层是 section（页面的 main 在外面）
import type { ReactNode } from 'react';
import type { EditRecord } from '../hooks/useEditRecord.ts';
import { useHoldBusy } from '../hooks/useHoldBusy.ts';
import { BackLink } from './BackLink.tsx';
import { DrawerClose, useInDrawer } from './DetailDrawer.tsx';
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
  const onClose = useInDrawer();
  useHoldBusy('editing', !onClose);
  const t = useEditT();
  const st = useEditStatus(rec.status, own);
  const { readonly, deleted } = rec;
  const del = (v: boolean) => void rec.setDeleted(v);
  // 只读时不写“改了就自动保存”（FA-2 视觉验收第 2 条）
  const status = (
    <p className={`${styles.status}${st.bad ? ` ${styles.statusBad}` : ''}`} role="status" data-testid="edit-status">
      {rec.status !== 'idle' || !readonly ? st.text : ''}
    </p>
  );
  const body = (
    <>
      {onClose ? (
        <div className={`${styles.top} ${styles.topDrawer}`}>
          <h2 className={styles.kind}>{kind}</h2>
          {status}
          <DrawerClose label={t('edit.close', {})} onClick={onClose} testId={`${prefix}-close`} />
        </div>
      ) : (
        <div className={styles.top}>
          <BackLink label={backLabel} onBack={onBack} testId="edit-back" />
          <h1 className={styles.kind}>{kind}</h1>
          {status}
        </div>
      )}
      {/* 只读：中性浅灰条（ReadonlyNotice 自己画）；已删除：红条 */}
      {readonly ? (
        <ReadonlyNotice role="alert" testId="edit-notice" updateTestId={`${prefix}-update`} className={styles.roNotice} />
      ) : deleted ? (
        <p className={styles.notice} role="alert" data-testid="edit-notice">
          <DeletedNotice onUndo={() => del(false)} testId={`${prefix}-undo`} />
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
    </>
  );
  // 整页是 main（首屏判断认它，first-paint-pages 登记着）；抽屉里是 section（页面的 main 在外面）
  return onClose ? (
    <section className={styles.inDrawer} data-testid={prefix}>
      {body}
    </section>
  ) : (
    <main className={styles.page} data-testid={prefix}>
      {body}
    </main>
  );
}
