// 记下之后的提示条（架构 5.1；定稿线框“记下之后”；R-122 磨砂）。打字条（TypeBar）和录音（RecordHost）共用，两边各一行：
// 直接收这一批的提示（hooks/useSavedBatch 的 notice）和它的动作（undo、undoOne、merge、closeNotice），文字、条目标签都在这里拼（第 13 条）
// • 一条：kit 的 UndoToast“已记下：… · 撤销”（8 秒自动收起）
// • 多条：“已记下 N 条”，展开后每条能修改（调用方开编辑页）或撤销；“拆错了，合并成一条”（这一批单条撤成过就不给）“全部撤销”；不自动收起，点“关闭”
// • 主句和附加句用“ · ”拼成一行；每条的标签是“类型 · 库里存的标题”
// • 按钮都是 kit 的 FormButton（点击区 --hit）
import { useState } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import type { BatchActs, BatchNotice } from '../hooks/useSavedBatch.ts';
import { usePlusLine, usePlusT } from '../hooks/usePlusT.ts';
import styles from './TypeBar.module.css';

export interface SavedNoticeProps {
  notice: BatchNotice;
  acts: BatchActs;
  onEdit?: ((table: string, id: string) => void) | undefined;
}

export function SavedNotice({ notice, acts, onEdit }: SavedNoticeProps) {
  const t = usePlusT();
  const line = usePlusLine();
  const [open, setOpen] = useState(false);
  const text = notice.lines.map((l) => line(l.key, l.params)).join(' · ');
  const undoAll = (): void => void acts.undo();
  if (notice.entries.length <= 1) {
    return <UndoToast message={text} undoLabel={t('plus.notice.undo', {})} onUndo={undoAll} onClose={acts.closeNotice} data-testid="type-notice" />;
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
            {notice.entries.map(({ ref, item }) => {
              const label = `${t(`plus.kind.${item.kind}`, {})} · ${ref.title}`;
              return (
                <li key={ref.id} className={styles.row}>
                  <span className={styles.grow}>{label}</span>
                  {onEdit ? (
                    <FormButton type="button" variant="ghost" aria-label={t('plus.notice.editOne', { label })} onClick={() => onEdit(ref.table, ref.id)}>{t('plus.notice.edit', {})}</FormButton>
                  ) : null}
                  <FormButton type="button" variant="ghost" aria-label={t('plus.notice.undoOne', { label })} onClick={() => void acts.undoOne(ref.id)}>{t('plus.notice.undo', {})}</FormButton>
                </li>
              );
            })}
          </ul>
          <div className={styles.row}>
            {notice.merge ? <FormButton type="button" variant="ghost" onClick={() => void acts.merge()}>{t('plus.notice.merge', {})}</FormButton> : null}
            <FormButton type="button" variant="ghost" onClick={undoAll}>{t('plus.notice.undoAll', {})}</FormButton>
          </div>
        </>
      ) : null}
      <div className={styles.row}>
        <FormButton type="button" variant="ghost" onClick={acts.closeNotice}>{t('plus.notice.close', {})}</FormButton>
      </div>
    </div>
  );
}
