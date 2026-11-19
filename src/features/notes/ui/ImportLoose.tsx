// 分类里导入没分类的记录（负责人 11-19：隐私记“也可以在分类里倒入没分类的记录”；问“导入怎么选”答“勾选多条”）：
// • 筛着某一类、并且还有没分类的记录时，分类那一排下面一行“导入没分类的 N 条”
// • 点开弹窗：没分类的记录一条一行（标题 + 日期），勾选；“导入 N 条”一次归进这一类；没写成的条数写一句、弹窗留着
// • 随手记、隐私记都是这一份（隐私记由来源重新加密写，useNoteList 的 moveInto）
// • can：这一条能不能归进分类（只读行不能；同拖进分类的 into.ok，两条路一个判断，独立评审 11-19 中 5）——不能的不列
// • 页面按分类给 key（换了分类整个重来，勾选、开着不带过去，独立评审 11-19 中 6）；有几条没写成时，勾选只留还没分类的（已写成的自动掉出去，中 7）
// 运行日志：notes import open；结果由 data 层记 notes category into
import { useState } from 'react';
import { Dialog, DialogClose } from '../../../kit/components/Dialog.tsx';
import dialog from '../../../kit/components/Dialog.module.css';
import { FormButton } from '../../../kit/components/Form.tsx';
import { rlog } from '../../../platform/run-log-api.ts';
import type { NoteItem, useNoteList } from '../hooks/useNoteList.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import styles from './CategoryDialogs.module.css';

type List = Pick<ReturnType<typeof useNoteList>, 'category' | 'counts' | 'loose' | 'moveInto'>;

export function ImportLoose({ l, day, can }: { l: List; day(it: NoteItem): string; can(id: string): boolean }) {
  const t = useNotesT();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(0);
  const cid = l.category;
  const name = l.counts.find((c) => c.id === cid)?.name ?? '';
  const loose = l.loose.filter((it) => can(it.id));
  // 勾着的只算此刻还没分类的那几条（部分写成以后，写成的自己掉出去）
  const sel = loose.filter((it) => picked.has(it.id)).map((it) => it.id);
  if (cid === null || (loose.length === 0 && !open)) return null;
  const close = (): void => {
    setOpen(false);
    setPicked(new Set());
    setFailed(0);
  };
  const toggle = (id: string): void => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const ok = async (): Promise<void> => {
    if (busy || sel.length === 0) return;
    setBusy(true);
    const r = await l.moveInto(sel, cid);
    setBusy(false);
    if (r.failed === 0) close();
    else setFailed(r.failed);
  };
  return (
    <>
      <button
        type="button"
        className={styles.importRow}
        onClick={() => {
          rlog('notes import open');
          setOpen(true);
        }}
        data-testid="notes-import-open"
      >
        {t('notes.import.open', { n: loose.length })}
        <span aria-hidden="true"> ›</span>
      </button>
      <Dialog open={open} onOpenChange={(o) => (o ? undefined : close())} title={t('notes.import.title', { name })}>
        <div className={styles.body}>
          <ul className={styles.pickList} data-testid="notes-import-list">
            {loose.map((it) => (
              <li key={it.id}>
                <label className={styles.pick}>
                  <input type="checkbox" checked={picked.has(it.id)} onChange={() => toggle(it.id)} data-testid={`notes-import-${it.id}`} />
                  <span className={styles.pickTitle}>{it.title}</span>
                  <span className={styles.pickDay}>{day(it)}</span>
                </label>
              </li>
            ))}
          </ul>
          {failed ? (
            <p className={styles.notice} role="alert" data-testid="notes-import-fail">
              {t('notes.import.fail', { n: failed })}
            </p>
          ) : null}
          <div className={dialog.actions}>
            <DialogClose asChild>
              <FormButton size="compact" type="button" data-testid="notes-import-cancel">
                {t('notes.cat.cancel', {})}
              </FormButton>
            </DialogClose>
            <FormButton size="compact" variant="primary" type="button" disabled={busy || sel.length === 0} onClick={() => void ok()} data-testid="notes-import-ok">
              {t('notes.import.ok', { n: sel.length })}
            </FormButton>
          </div>
        </div>
      </Dialog>
    </>
  );
}
