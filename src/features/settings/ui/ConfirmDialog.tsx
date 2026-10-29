// 设置页的确认弹层：移除设备、退出其他所有设备、退出这台设备之前先问一次（kit 的 Dialog：焦点锁定、Esc 关闭）
import { Dialog, DialogClose } from '../../../kit/components/Dialog.tsx';
import { Pressable } from '../../../motion/components.ts';
import styles from './SettingsPage.module.css';

export interface ConfirmProps {
  open: boolean;
  title: string;
  body: string;
  okLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onOk(): void;
  onCancel(): void;
}

export function ConfirmDialog({ open, title, body, okLabel, cancelLabel, danger = false, onOk, onCancel }: ConfirmProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onCancel())} title={title} description={body}>
      <div className={styles.actions}>
        <DialogClose asChild>
          <Pressable className={styles.btn}>{cancelLabel}</Pressable>
        </DialogClose>
        <Pressable className={danger ? `${styles.primary} ${styles.primaryDanger}` : styles.primary} onClick={onOk}>
          {okLabel}
        </Pressable>
      </div>
    </Dialog>
  );
}
