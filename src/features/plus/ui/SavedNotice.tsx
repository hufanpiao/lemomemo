// 记下之后的提示条（架构 5.1；定稿线框“记下之后”；R-122 磨砂）
// • 一条：kit 的 UndoToast“已记下：… · 撤销”（8 秒自动收起）
// • 多条：“已记下 N 条”，展开后每条能修改（调用方开编辑页）或撤销；“拆错了，合并成一条”“全部撤销”；不自动收起，点“关闭”
// • 按钮都是 kit 的 FormButton（点击区 --hit）
import { useState } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { usePlusT } from '../hooks/usePlusT.ts';
import styles from './TypeBar.module.css';

/** 展开后的一行：哪张表、哪一条、显示什么 */
export interface SavedRow {
  table: string;
  id: string;
  label: string;
}

export interface SavedNoticeProps {
  text: string;
  rows: readonly SavedRow[];
  onUndoAll(): void;
  onUndoOne(id: string): void;
  onMerge(): void;
  onEdit?: ((table: string, id: string) => void) | undefined;
  onClose(): void;
}

export function SavedNotice({ text, rows, onUndoAll, onUndoOne, onMerge, onEdit, onClose }: SavedNoticeProps) {
  const t = usePlusT();
  const [open, setOpen] = useState(false);
  if (rows.length <= 1) {
    return <UndoToast message={text} undoLabel={t('plus.notice.undo', {})} onUndo={onUndoAll} onClose={onClose} data-testid="type-notice" />;
  }
  return (
    <div className={styles.saved} role="status" data-testid="type-notice">
      <div className={styles.row}>
        <span className={styles.grow}>{text}</span>
        <FormButton type="button" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(open ? 'plus.notice.less' : 'plus.notice.more', {})}
        </FormButton>
      </div>
      {open ? (
        <>
          <ul className={styles.list} aria-label={t('plus.notice.list', {})}>
            {rows.map((r) => (
              <li key={r.id} className={styles.row}>
                <span className={styles.grow}>{r.label}</span>
                {onEdit ? (
                  <FormButton type="button" variant="ghost" aria-label={t('plus.notice.editOne', { label: r.label })} onClick={() => onEdit(r.table, r.id)}>{t('plus.notice.edit', {})}</FormButton>
                ) : null}
                <FormButton type="button" variant="ghost" aria-label={t('plus.notice.undoOne', { label: r.label })} onClick={() => onUndoOne(r.id)}>{t('plus.notice.undo', {})}</FormButton>
              </li>
            ))}
          </ul>
          <div className={styles.row}>
            <FormButton type="button" variant="ghost" onClick={onMerge}>{t('plus.notice.merge', {})}</FormButton>
            <FormButton type="button" variant="ghost" onClick={onUndoAll}>{t('plus.notice.undoAll', {})}</FormButton>
          </div>
        </>
      ) : null}
      <div className={styles.row}>
        <FormButton type="button" variant="ghost" onClick={onClose}>{t('plus.notice.close', {})}</FormButton>
      </div>
    </div>
  );
}
