// 编辑页外框（B2 FA-2）：顶栏“‹ 返回 · 类型名 · 保存状态”、顶部提示（只读、没保存上）、正文、底部按钮。不含业务和文案（调用方传）
// 保存状态是常驻的 role="status"，读屏会播报“已自动保存”“没保存上”
// 编辑页挂着期间占住升级中心的 busy（BUSY-wire）：不出版本横幅、不自动重新载入，离开编辑页就释放
import type { ReactNode } from 'react';
import { Pressable } from '../../motion/components.ts';
import { useHoldBusy } from '../hooks/useHoldBusy.ts';
import styles from './EditShell.module.css';

export interface EditShellProps {
  kind: string;
  backLabel: string;
  onBack(): void;
  status: string;
  statusBad?: boolean;
  notice?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  'data-testid'?: string;
}

export function EditShell({ kind, backLabel, onBack, status, statusBad, notice, children, actions, ...rest }: EditShellProps) {
  useHoldBusy('editing');
  return (
    <main className={styles.page} data-testid={rest['data-testid']}>
      <div className={styles.top}>
        <Pressable className={styles.back} onClick={onBack} data-testid="edit-back">
          {`‹ ${backLabel}`}
        </Pressable>
        <h1 className={styles.kind}>{kind}</h1>
        <p className={`${styles.status}${statusBad ? ` ${styles.statusBad}` : ''}`} role="status" data-testid="edit-status">
          {status}
        </p>
      </div>
      {notice ? (
        <p className={styles.notice} role="alert" data-testid="edit-notice">
          {notice}
        </p>
      ) : null}
      {children}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </main>
  );
}
