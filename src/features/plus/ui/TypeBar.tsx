// 打字条（B3 任务单 S2、FA-2；定稿线框“点一下＋打字”；R-353）
// • 贴键盘上沿，打开就聚焦；边打边预览“会记成这样”；回车或“记下”保存
// • 下滑把手 / “收起” / Esc：已打的字留草稿再关；“展开编辑”：把字和日历页选中的那天交给调用方开完整新建页
// • 过去的月日：出确认行“补记 / 记到”，选了才保存；关掉确认行时输入条里只留等确认那条的原文（同一句里已经存了的去掉），
//   去不干净时原话整句留着，输入条上方提示“同一句里其他几条已经记下了”（主持人 11-07 定）
// • 保存后的“已记下 · 撤销”用 kit 的 UndoToast（和撤销条同一套磨砂，R-122）；提示条还在时 Ctrl+Z 撤销这一批（S24），
//   焦点在有字的输入框里时让给浏览器撤销打字
// • 文字一律经 t()（A20）；按钮用 kit 的 FormButton，输入框用 kit Form 的 .input（G11 输入框令牌、触屏 16px）
import { useEffect, useRef, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { FormButton } from '../../../kit/components/Form.tsx';
import form from '../../../kit/components/Form.module.css';
import { isEditable, useKeys } from '../../../kit/hooks/useKeys.ts';
import { usePlusLine, usePlusT } from '../hooks/usePlusT.ts';
import { useTypeBar, type CallAi, type Writer } from '../hooks/useTypeBar.ts';
import { ConfirmRow } from './ConfirmRow.tsx';
import { SavedNotice } from './SavedNotice.tsx';
import styles from './TypeBar.module.css';

/** 下滑多少（px）算收起 */
export const SWIPE_CLOSE_PX = 40;

export interface TypeBarProps {
  /** 日历页选中的那天（R-353）；别的页为 null */
  day: DateStr | null;
  callAi?: CallAi;
  writer?: Writer;
  online?: () => boolean;
  /** 展开成完整新建页（R-353）：带上已打的字和选中的日子 */
  onExpand(text: string, day: DateStr | null): void;
  /** 提示条里“修改”某一条：开它的编辑页（不给就不显示“修改”） */
  onEdit?: (table: string, id: string) => void;
  onClose(): void;
}

const dayOf = (it: AiItem): string => {
  const d = it.kind === 'event' ? it.date : it.due;
  return [d ? d.slice(5) : '', it.time ?? ''].filter(Boolean).join(' ');
};

export default function TypeBar({ day, callAi, writer, online, onExpand, onEdit, onClose }: TypeBarProps) {
  const t = usePlusT();
  const line = usePlusLine();
  const s = useTypeBar({ day, callAi, writer, online });
  const input = useRef<HTMLInputElement>(null);
  const startY = useRef<number | null>(null);

  useEffect(() => input.current?.focus(), []);
  useKeys({
    'mod+z': (e) => {
      if (!s.notice) return false;
      const el = e.target;
      if (isEditable(el) && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value !== '' : true)) return false;
      void s.undo();
      return true;
    },
  });

  const close = () => void s.stash().then(onClose);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void s.submit();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const down = (e: PointerEvent) => {
    startY.current = e.clientY;
  };
  const up = (e: PointerEvent) => {
    if (startY.current !== null && e.clientY - startY.current >= SWIPE_CLOSE_PX) close();
    startY.current = null;
  };

  const first = s.preview[0];
  const kind = (it: AiItem): string => t(`plus.kind.${it.kind}`, {});
  const previewText = first
    ? `${kind(first)} · ${dayOf(first) ? t('plus.type.previewDay', { title: first.title, day: dayOf(first) }) : t('plus.type.previewNoDay', { title: first.title })}`
    : '';

  return (
    <>
      <form className={styles.bar} onSubmit={onSubmit} aria-label={t('plus.type.label', {})} data-testid="type-bar">
        <div className={styles.grip} onPointerDown={down} onPointerUp={up} aria-hidden="true" />
        {s.asking ? (
          <ConfirmRow item={s.asking} onChoose={(c) => void s.choose(c)} onDismiss={s.dismissConfirm} />
        ) : (
          <>
            {s.partSaved ? (
              <div className={styles.preview} role="status" data-testid="type-part-saved">{t('plus.type.partSaved', {})}</div>
            ) : null}
            <div className={styles.row}>
              <input
                ref={input}
                className={form.input}
                value={s.text}
                onChange={(e) => s.setText(e.target.value)}
                onKeyDown={onKey}
                placeholder={t('plus.type.ph', {})}
                aria-label={t('plus.type.label', {})}
                enterKeyHint="done"
                data-testid="type-input"
              />
              <FormButton type="submit" variant="primary" disabled={s.text.trim() === '' || s.status === 'organizing'}>
                {t('plus.type.save', {})}
              </FormButton>
            </div>
            <div className={styles.preview} aria-live="polite" data-testid="type-preview">
              {first ? t('plus.type.preview', { text: s.preview.length > 1 ? `${previewText} · ${t('plus.type.more', { n: s.preview.length - 1 })}` : previewText }) : ''}
            </div>
            <div className={styles.row}>
              <FormButton type="button" variant="ghost" onClick={() => {
                s.dropDraft();
                onExpand(s.text, day);
              }}>{t('plus.type.expand', {})}</FormButton>
              <FormButton type="button" variant="ghost" onClick={close}>{t('plus.type.close', {})}</FormButton>
            </div>
          </>
        )}
        {s.error ? (
          <div className={styles.err} role="alert">{t(s.error === 'nothing' ? 'plus.notice.nothing' : 'plus.notice.notSaved', {})}</div>
        ) : null}
      </form>
      {s.notice ? (
        <SavedNotice
          text={s.notice.lines.map((l) => line(l.key, l.params)).join(' · ')}
          rows={s.notice.entries.map((e) => ({ table: e.ref.table, id: e.ref.id, label: `${kind(e.item)} · ${e.item.title}` }))}
          onUndoAll={() => void s.undo()}
          onUndoOne={(id) => void s.undoOne(id)}
          onMerge={() => void s.merge()}
          onEdit={onEdit}
          onClose={s.closeNotice}
        />
      ) : null}
    </>
  );
}
