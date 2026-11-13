// 确认弹层（kit 的 Dialog：焦点锁定、Esc 关闭）：设置页移除设备、退出其他所有设备、退出这台设备之前先问一次；
// 随手记带插图的转成待办 / 日程之前先问一次（R-414，11-13 从 features/settings/ui 挪进 kit，免得各写一份）
import { Dialog, DialogClose } from './Dialog.tsx';
import styles from './Dialog.module.css';
import { FormButton } from './Form.tsx';

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
          <FormButton size="compact">{cancelLabel}</FormButton>
        </DialogClose>
        {/* B2-UI-b W4：.primary → compact primary，.primary.primaryDanger → compact dangerFill */}
        <FormButton size="compact" variant={danger ? 'dangerFill' : 'primary'} onClick={onOk}>
          {okLabel}
        </FormButton>
      </div>
    </Dialog>
  );
}
