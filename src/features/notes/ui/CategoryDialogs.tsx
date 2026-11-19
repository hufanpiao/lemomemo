// 分类的两个弹窗，随手记、隐私记共用（负责人 11-19：隐私记“新建分类”“长按分类格可以改名、删除，删分类时里面的记录不删，变回没分类”；
// 随手记“其他可以自己编辑分类，可以创建分类”）。哪一套分类由调用方给的 create / rename / remove 定（useNoteList 按数据来源分）。
// • 新建：起名字，去首尾空白、最多 max 个字（按字算，emoji 也算一个；第三方实测 11-19 问题 5：原来 maxLength 按 UTF-16 算，emoji 只能输 6 个）；
//   建好（或同名已有）回分类 id；没建上留在弹窗里写一句
// • 改名删除：上面改名字（同一套里重名写一句、不改），下面“删除这个分类”→ 再问一次“里面的 N 条记录不删，变回没分类”才删
// • 输入框占满弹窗一整行（问题 5：原来约 190px，输满 12 个字第一个字被裁掉）
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog, DialogClose } from '../../../kit/components/Dialog.tsx';
import dialog from '../../../kit/components/Dialog.module.css';
import { FormButton } from '../../../kit/components/Form.tsx';
import form from '../../../kit/components/Form.module.css';
import { CATEGORY_NAME_MAX, type ActionResult, type CategoryCount, type useNoteList } from '../hooks/useNoteList.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import styles from './CategoryDialogs.module.css';

type List = Pick<ReturnType<typeof useNoteList>, 'setCategory' | 'newCategory' | 'renameCategory' | 'deleteCategory'>;
// 结果类型从列表 hook 推出来（界面层不许直接引数据层）
type NewCategory = Awaited<ReturnType<List['newCategory']>>;
type RenameResult = Awaited<ReturnType<List['renameCategory']>>;

const cut = (v: string, max: number): string => [...v].slice(0, max).join('');

function NameInput({ value, max, label, onChange, testId }: { value: string; max: number; label: string; onChange(v: string): void; testId: string }) {
  const t = useNotesT();
  return (
    <input
      className={`${form.input} ${styles.name}`}
      value={value}
      onChange={(e) => onChange(cut(e.target.value, max))}
      placeholder={t('notes.cat.placeholder', { n: max })}
      aria-label={label}
      // 不让 iOS 当成填联系人的框（负责人 11-19 晚截图：键盘上出“自动填充联系人”；占位字里的“名字”也一起去掉）
      autoComplete="off"
      enterKeyHint="done"
      data-testid={testId}
    />
  );
}

function NewCategoryDialog(p: { open: boolean; onClose(): void; create(name: string): Promise<NewCategory>; max: number; onDone(id: string): void }) {
  const t = useNotesT();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<'dup' | 'fail' | null>(null);
  // 建好要进的那一类：等弹窗关掉、它的层退掉（页面不再锁滚动）以后再交出去换页。
  // 锁着滚动直接换页，文档在整页过渡里从“不能滚”变成“能滚”，webkit 整页崩（同 kit/hooks/layers.ts keepScroll 那条，11-19 e2e 复现）
  const [done, setDone] = useState<string | null>(null);
  const onDone = useRef(p.onDone);
  onDone.current = p.onDone;
  useEffect(() => {
    if (p.open || done === null) return;
    setDone(null);
    onDone.current(done);
  }, [p.open, done]);
  const close = (): void => {
    setName('');
    setFailed(null);
    p.onClose();
  };
  const ok = async (): Promise<void> => {
    if (busy || name.trim() === '') return;
    setBusy(true);
    const r = await p.create(name);
    setBusy(false);
    if (r.result !== 'ok') {
      setFailed(r.result === 'dup' ? 'dup' : r.result === 'empty' || r.result === 'silent' ? null : 'fail');
      return;
    }
    setDone(r.id);
    close();
  };
  return (
    // 建的过程中不许关（独立评审 11-19 中 10：关了以后结果回来照样跳进新分类）
    <Dialog open={p.open} onOpenChange={(o) => (o || busy ? undefined : close())} title={t('notes.cat.newTitle', {})}>
      <form
        className={styles.body}
        onSubmit={(e) => {
          e.preventDefault();
          void ok();
        }}
      >
        <NameInput
          value={name}
          max={p.max}
          label={t('notes.cat.newTitle', {})}
          onChange={(v) => {
            setName(v);
            setFailed(null);
          }}
          testId="cat-new-name"
        />
        {failed ? (
          <p className={styles.notice} role="alert" data-testid="cat-new-fail">
            {t(failed === 'dup' ? 'notes.cat.dup' : 'notes.cat.createFail', {})}
          </p>
        ) : null}
        <div className={dialog.actions}>
          <DialogClose asChild>
            <FormButton size="compact" type="button" disabled={busy} data-testid="cat-new-cancel">
              {t('notes.cat.cancel', {})}
            </FormButton>
          </DialogClose>
          <FormButton size="compact" variant="primary" type="submit" disabled={busy || name.trim() === ''} data-testid="cat-new-ok">
            {t('notes.cat.create', {})}
          </FormButton>
        </div>
      </form>
    </Dialog>
  );
}

export interface EditingCategory {
  id: string;
  name: string;
  count: number;
}

function EditCategoryDialog(p: {
  cat: EditingCategory | null;
  onClose(): void;
  rename(id: string, name: string): Promise<RenameResult>;
  remove(id: string): Promise<ActionResult | 'gone'>;
  max: number;
}) {
  const t = useNotesT();
  const [name, setName] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<'dup' | 'fail' | null>(null);
  const cat = p.cat;
  const value = name ?? cat?.name ?? '';
  const close = (): void => {
    setName(null);
    setAsk(false);
    setMsg(null);
    p.onClose();
  };
  const save = async (): Promise<void> => {
    if (!cat || busy || value.trim() === '') return;
    setBusy(true);
    const r = await p.rename(cat.id, value);
    setBusy(false);
    if (r === 'ok' || r === 'gone') close();
    else if (r === 'dup') setMsg('dup');
    else if (r !== 'empty' && r !== 'silent') setMsg('fail');
  };
  const del = async (): Promise<void> => {
    if (!cat || busy) return;
    setBusy(true);
    const r = await p.remove(cat.id);
    setBusy(false);
    if (r === 'ok' || r === 'gone') close();
    else setMsg('fail');
  };
  return (
    <Dialog open={cat !== null} onOpenChange={(o) => (o ? undefined : close())} title={t('notes.cat.editTitle', { name: cat?.name ?? '' })}>
      {ask && cat ? (
        <div className={styles.body}>
          <p className={styles.ask} data-testid="cat-edit-ask">
            {t('notes.cat.deleteAsk', { name: cat.name, n: cat.count })}
          </p>
          {msg ? (
            <p className={styles.notice} role="alert">
              {t('notes.cat.editFail', {})}
            </p>
          ) : null}
          <div className={dialog.actions}>
            <FormButton size="compact" type="button" onClick={() => setAsk(false)} data-testid="cat-edit-back">
              {t('notes.cat.cancel', {})}
            </FormButton>
            <FormButton size="compact" variant="danger" type="button" disabled={busy} onClick={() => void del()} data-testid="cat-edit-delete-ok">
              {t('notes.cat.deleteOk', {})}
            </FormButton>
          </div>
        </div>
      ) : (
        <form
          className={styles.body}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <NameInput
            value={value}
            max={p.max}
            label={t('notes.cat.editTitle', { name: cat?.name ?? '' })}
            onChange={(v) => {
              setName(v);
              setMsg(null);
            }}
            testId="cat-edit-name"
          />
          {msg ? (
            <p className={styles.notice} role="alert" data-testid="cat-edit-msg">
              {t(msg === 'dup' ? 'notes.cat.dup' : 'notes.cat.editFail', {})}
            </p>
          ) : null}
          <button type="button" className={styles.delete} onClick={() => setAsk(true)} data-testid="cat-edit-delete">
            {t('notes.cat.delete', {})}
          </button>
          <div className={dialog.actions}>
            <DialogClose asChild>
              <FormButton size="compact" type="button" data-testid="cat-edit-cancel">
                {t('notes.cat.cancel', {})}
              </FormButton>
            </DialogClose>
            <FormButton size="compact" variant="primary" type="submit" disabled={busy || value.trim() === ''} data-testid="cat-edit-ok">
              {t('notes.cat.rename', {})}
            </FormButton>
          </div>
        </form>
      )}
    </Dialog>
  );
}


export interface CategoryDialogs {
  /** 打开“新分类”：建好（或同名已有）就筛到那一类（隐私记是 #/vault/c/<id>） */
  add(): void;
  /** 长按某个分类：打开改名、删除 */
  edit(c: CategoryCount): void;
  /** 两个弹窗本身：列表页挂一份 */
  dialogs: ReactNode;
}

/** 随手记列表挂一份，分类那一排（CatChips）、隐私记首页宫格都经它开弹窗（隐私记不直接引 notes 的界面组件，经 NotesHomeApi 拿 add、edit） */
export function useCategoryDialogs(l: List): CategoryDialogs {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EditingCategory | null>(null);
  return {
    add: () => setAdding(true),
    edit: (c) => setEditing({ id: c.id, name: c.name, count: c.count }),
    dialogs: (
      <>
        <NewCategoryDialog open={adding} onClose={() => setAdding(false)} create={l.newCategory} max={CATEGORY_NAME_MAX} onDone={(id) => l.setCategory(id)} />
        <EditCategoryDialog
          cat={editing}
          onClose={() => setEditing(null)}
          rename={l.renameCategory}
          // 正筛着的这一类删了：由 useNoteList 发现筛的分类没了自己回“全部”（独立评审 11-19 低 14：这里再回一次是两套做同一件事）
          remove={l.deleteCategory}
          max={CATEGORY_NAME_MAX}
        />
      </>
    ),
  };
}
