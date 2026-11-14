// 记下之后的提示条（架构 5.1；定稿线框“记下之后”；R-122 磨砂）。打字条（TypeBar）和录音（RecordHost）共用，两边各一行：
// 直接收这一批的提示（hooks/useSavedBatch 的 notice）和它的动作（undo、undoOne、merge、closeNotice），文字、条目标签都在这里拼（第 13 条）
// • 一条：kit 的 UndoToast“已记下：… · 撤销”（8 秒自动收起）
// • 多条：“已记下 N 条”，展开后每条能修改（调用方开编辑页）或撤销；“拆错了，合并成一条”（这一批单条撤成过就不给）“全部撤销”；不自动收起，点“关闭”
// • 主句和附加句用“ · ”拼成一行；每条的标签是“类型 · 库里存的标题”
// • 按钮都是 kit 的 FormButton（点击区 --hit）
// • 模糊先按记下保存的（B4b-3，notice.alt，架构 5.14 第 2、7 点）：一条也用展开式的块，多一行“改成搜索”（撤销这一批，按同一句话查找）；
//   alt.found 时下面再给 smart-search 的 AssistPeek“也帮你找了一下：N 条 ›”“是要取消吗？找到 N 条 ›”（排除这一批）
import { Suspense, useState } from 'react';
import { rlog } from '../../../platform/run-log-api.ts';
import { AssistPeek } from '../../smart-search/index.ts';
import { FormButton } from '../../../kit/components/Form.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import type { BatchActs, BatchNotice } from '../hooks/useSavedBatch.ts';
import { usePlusLine, usePlusT } from '../hooks/usePlusT.ts';
import { toAssist } from '../hooks/assist-open.ts';

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
  const alt = notice.alt;
  const toSearch = alt === null ? null : (): void => {
    rlog(`notice to_search intent=${alt.ask.intent} n=${notice.entries.length}`);
    const raw = notice.raw;
    // 撤干净了才换成查找（撤了一半、没撤成的留在提示条上，不跳）
    void acts.undo().then((ok) => {
      if (ok === true) toAssist({ ask: alt.ask, raw, aiUsed: 0, from: 'notice', day: null });
    });
  };
  const altRows = alt === null || toSearch === null ? null : (
    <div className={styles.row} data-testid="type-notice-alt">
      <FormButton type="button" variant="ghost" onClick={toSearch} data-testid="notice-to-search">{t('plus.notice.toSearch', {})}</FormButton>
      {alt.found ? (
        <Suspense fallback={null}>
          <AssistPeek ask={alt.ask} exclude={notice.entries.map((e) => e.ref.id)} undoSaved={() => acts.undo()} />
        </Suspense>
      ) : null}
    </div>
  );
  if (notice.entries.length <= 1 && altRows === null) {
    return <UndoToast message={text} undoLabel={t('plus.notice.undo', {})} onUndo={undoAll} onClose={acts.closeNotice} data-testid="type-notice" />;
  }
  return (
    <div className={styles.saved} role="status" data-testid="type-notice">
      <div className={styles.row}>
        <span className={styles.grow}>{text}</span>
        {notice.entries.length <= 1 ? (
          <FormButton type="button" variant="ghost" onClick={undoAll}>{t('plus.notice.undo', {})}</FormButton>
        ) : (
          <FormButton type="button" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {t(open ? 'plus.notice.less' : 'plus.notice.more', {})}
          </FormButton>
        )}
      </div>
      {altRows}
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
