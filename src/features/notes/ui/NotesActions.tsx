// 随手记页的“⋯”菜单、合并分类提示条、转成待办 / 日程的流程和确认窗（从 NotesPage.tsx 拆出来，R-413、R-414 11-13）
// • 菜单：转成待办 / 转成日程 / 移到隐私记（B5 S7）/ 删除；只读行变淡、点了由页面拦下
// • 提示条（R-413，线框 MERGE）：“‘读书’和‘书单’两个分类很像，合成一个吗？ 合并 / 不用”
// • 转换（R-414）的规则见 shared/logic/notes/note-convert.ts 文件头；结果出在输入行上面
import { useState } from 'react';
import { ConfirmDialog } from '../../../kit/components/ConfirmDialog.tsx';
import { FormButton } from '../../../kit/components/Form.tsx';
import { Popover } from '../../../kit/components/Popover.tsx';
import type { useListActions } from '../../../kit/hooks/useListActions.ts';
import { Pressable } from '../../../motion/components.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { MergeHint } from '../hooks/useMergeHint.ts';
import type { MergeUndo } from '../hooks/useNotesToast.ts';
import { actionResult, type ActionResult, type ConvertKind, type NoteItem, type useNoteList } from '../hooks/useNoteList.ts';
import { useNotesT, type NotesMsgKey } from '../hooks/useNotesT.ts';
import type { ImgMsgKey } from './NoteImages.tsx';
import row from '../../../kit/components/NoteRow.module.css';
import styles from './NotesPage.module.css';

/** 随手记页自己另加的提示条：插图提示、转换结果、合并的撤销条（删除的撤销条、出错条在 kit 的 useListActions 里） */
export type ImgTip = { kind: 'img'; key: ImgMsgKey; trash: boolean };
export type ConvTip = { kind: 'conv'; key: Extract<NotesMsgKey, `notes.conv.${'moved' | 'kept'}.${string}` | 'notes.conv.empty' | 'notes.conv.left' | 'notes.conv.long'> };
export type PageTip = ImgTip | ConvTip | MergeUndo;
/** 带插图的转换要先问一下（R-414，线框 S8-2） */
export type ConvAsk = { id: string; kind: ConvertKind; images: number };

/**
 * “⋯”菜单：看得见 24px，点按区 ::after 扩到 44。转成待办 / 转成日程（R-414）、移到隐私记（B5 S7，线框 s7 菜单）在“删除”上面。
 * long：备注放不下，两项变淡（aria-disabled）、下面写原因，点了不动；只读行的两项也变淡，点了由页面拦下
 */
export function MoreMenu({ id, ro, open, onOpenChange, onDelete, long, onConvert, onMove }: {
  id: string; ro: boolean; open: boolean; onOpenChange(o: boolean): void; onDelete(): void; long: boolean; onConvert(kind: ConvertKind): void; onMove(): void;
}) {
  const t = useNotesT();
  const conv = (kind: ConvertKind) => (
    <Pressable
      className={`${row.menuItem} ${row.menuPlain}`}
      aria-disabled={ro || long || undefined}
      onClick={() => (long ? undefined : onConvert(kind))}
      data-testid={`notes-to-${kind}-${id}`}
      data-no-proxy=""
    >
      {t(kind === 'todo' ? 'notes.conv.todo' : 'notes.conv.event', {})}
    </Pressable>
  );
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={t('notes.menu', {})}
      align="end"
      className={row.menu}
      trigger={
        <button type="button" className={row.more} aria-label={t('notes.more', {})} data-testid={`notes-more-${id}`}>
          ⋯
        </button>
      }
    >
      {conv('todo')}
      {conv('event')}
      {long ? (
        <p className={row.menuNote} data-testid={`notes-conv-long-${id}`}>
          {t('notes.conv.long', {})}
        </p>
      ) : null}
      <Pressable className={`${row.menuItem} ${row.menuPlain}`} aria-disabled={ro || undefined} onClick={onMove} data-testid={`notes-to-vault-${id}`} data-no-proxy="">
        {t('notes.toVault', {})}
      </Pressable>
      {/* 只读行的“删除”变淡、aria-disabled，点了照样由 del 拦下出提示条（同待办页的 ×） */}
      <Pressable className={row.menuItem} aria-disabled={ro || undefined} onClick={onDelete} data-testid={`notes-del-${id}`} data-no-proxy="">
        {t('notes.delete', {})}
      </Pressable>
    </Popover>
  );
}

/**
 * 合并分类提示条（R-413，线框 MERGE）：两个按钮没写成的结果都由页面的出错条、只读提示接；“不用”记下这一对，提示条随即换下一对或消失。
 * 合并成了调 onMerged(这一对)（页面出 8 秒撤销条，撤销调它的 undo，R-415 ③）。写入期间两个按钮都禁用：连点不会落到写完以后换上来的下一对上，
 * 也不会再合并一次把第一次的撤销条顶掉
 */
export function MergeBar({ hint, onResult, onMerged }: { hint: MergeHint; onResult(r: ActionResult): void; onMerged(hint: MergeHint): void }) {
  const t = useNotesT();
  const [busy, setBusy] = useState(false);
  const run = (go: () => Promise<void>) => {
    setBusy(true);
    void go().finally(() => setBusy(false));
  };
  const merge = async () => {
    const r = await hint.merge();
    if (r === 'ok') onMerged(hint);
    else onResult(r);
  };
  return (
    <section className={styles.merge} aria-label={t('notes.merge.label', {})} data-testid="notes-merge">
      <span className={styles.mergeText}>{t('notes.merge.ask', { a: hint.keepName, b: hint.mergeName })}</span>
      <FormButton size="compact" variant="primary" disabled={busy} onClick={() => run(merge)} data-testid="notes-merge-go">
        {t('notes.merge.go', {})}
      </FormButton>
      <FormButton size="compact" disabled={busy} onClick={() => run(async () => onResult(await hint.dismiss()))} data-testid="notes-merge-no">
        {t('notes.merge.no', {})}
      </FormButton>
    </section>
  );
}

/**
 * 转成待办 / 日程的流程（R-414）：只读行拦下；带插图的先问（ask 不为空时页面画确认窗，问了就定下保留原条），其余直接转；结果出在输入行上面：
 * “已转成…”、“先别再转”（left）、没有字或太长“转不了”；正在转（busy）、已经没了、切换账号中不提示；其余（含抛异常）走出错条 / 只读提示
 */
export function useConvertFlow(run: ReturnType<typeof useNoteList>['convert'], a: ReturnType<typeof useListActions<PageTip>>) {
  const [ask, setAsk] = useState<ConvAsk | null>(null);
  const go = async (id: string, kind: ConvertKind, keep: boolean) => {
    setAsk(null);
    const r = await run(id, kind, keep).catch(() => null);
    if (r === null) a.report('failed');
    else if (r.ok) a.g.show({ kind: 'conv', key: `notes.conv.${r.kept ? 'kept' : 'moved'}.${kind}` });
    else if (r.left) a.g.show({ kind: 'conv', key: 'notes.conv.left' });
    else if (r.reason === 'empty' || r.reason === 'too_long') a.g.show({ kind: 'conv', key: r.reason === 'empty' ? 'notes.conv.empty' : 'notes.conv.long' });
    else a.report(r.reason === 'gone' || r.reason === 'busy' ? 'silent' : actionResult(r.reason));
  };
  return {
    ask,
    start(it: NoteItem, kind: ConvertKind) {
      if (a.isRo(it.id)) a.g.block();
      else if (it.images > 0) setAsk({ id: it.id, kind, images: it.images });
      else void go(it.id, kind, false);
    },
    confirm() {
      rlog(`notes convert confirm ask=${ask ? ask.kind : 'none'}`);
      if (ask) void go(ask.id, ask.kind, true);
    },
    cancel: () => setAsk(null),
  };
}

/** 带插图的转成待办 / 日程之前问一次（R-414，线框 S8-2；D-13：原条保留，图片还在原处） */
export function ConvertAsk({ ask, onOk, onCancel }: { ask: ConvAsk; onOk(): void; onCancel(): void }) {
  const t = useNotesT();
  const todo = ask.kind === 'todo';
  return (
    <ConfirmDialog
      open
      title={t(todo ? 'notes.conv.todo' : 'notes.conv.event', {})}
      body={t(todo ? 'notes.conv.dlg.todo' : 'notes.conv.dlg.event', { n: ask.images })}
      okLabel={t(todo ? 'notes.conv.dlg.okTodo' : 'notes.conv.dlg.okEvent', {})}
      cancelLabel={t('notes.conv.dlg.cancel', {})}
      onOk={onOk}
      onCancel={onCancel}
    />
  );
}
