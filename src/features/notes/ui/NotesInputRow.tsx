// 随手记页底部输入行（视觉稿 .inrow、线框 COMPOSER；11-13 R-416 从 NotesPage.tsx 拆出来，页面不超行数上限）
// • 规则见下面 InputRow 的注释；聚焦、模糊层的约定见 NotesPage.tsx 文件头
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { notesInput } from '../../../kit/state/new-item.ts';
import { Pressable } from '../../../motion/components.ts';
import { errName } from '../../../platform/env.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { focusInPlace, inPlaceTouchEnd, inPlaceTouchStart, keepFieldFocus } from '../../../platform/viewport.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import { PendingPics, PickButtons, type ImagesResult, type PendingPic } from './NoteImages.tsx';
import styles from './NotesPage.module.css';

/**
 * 底部输入行（视觉稿 .inrow、线框 COMPOSER）：右边是“图片”，打了字或挂了图才出“记下”；回车或点“记下”就存，存的同时输入框失焦、收起键盘，
 * 输入行回到底部（R-416，负责人 11-13“按回车记下后输入框应该消失，不是继续记下一条”）。
 * 选了图（R-416，负责人 11-13“选择要上传的图片后不应该直接记录”）：先挂成待记下的小图（PendingPics，可“×”去掉），点“记下”时字和图一起记成新的一条（onImages）。
 * 没记成：字放回（记下进行中又打了字的，留新打的）；没插成的图放回小图最前面（进行中新选的排在后面，不冲掉）；抛错按没记成算。
 * 输入行正上方一个外框（.above）按顺序放页面的提示条（tip）和小图：手机上 fixed 跟着输入行走，电脑上贴在 .dock 上沿；
 * 外框和 form 一样挂 keepFieldFocus（台账 Q-25）：键盘弹着时点“×”不让输入框失焦，第一下就点得中。
 * 有撤销条时整块往上让一格（外框 .dockUp，NotesPage.module.css）
 * 打的字、待记下的小图由页面经 useInputDraft 拿着（B6）：电脑版和手机排法互换时（电脑版分包到了、窗口宽窄跨过 900px）输入行会重新挂上，字和图不能丢
 */
export function InputRow({
  field: input,
  state,
  onTyping,
  onAdd,
  onImages,
  tip,
}: {
  /** 页面拿着，点模糊层时让它失焦（R-401） */
  field: RefObject<HTMLInputElement | null>;
  /** 输入框得到 / 失去焦点（页面据此画不画模糊层） */
  onTyping(on: boolean): void;
  onAdd(text: string): Promise<boolean>;
  onImages(text: string, files: readonly File[]): Promise<ImagesResult>;
  /** 页面的提示条、出错条（放在小图上面） */
  tip: ReactNode;
  /** 打的字、待记下的小图（页面的 useInputDraft） */
  state: InputDraft;
}) {
  const t = useNotesT();
  const { draft, setDraft, pics, setPics, seq } = state;
  const has = draft.trim() !== '' || pics.length > 0;
  const count = useRef(0);
  useEffect(() => {
    if (pics.length !== count.current) rlog(`notes pend n=${pics.length}`);
    count.current = pics.length;
  }, [pics.length]);
  useLayoutEffect(() => {
    notesInput.focus = () => focusInPlace(input.current, 'open');
    return () => {
      notesInput.focus = undefined;
    };
  }, [input]);
  // 输入框聚焦着被卸下（电脑版、手机排法互换）时 React 不补发 onBlur：这里补一次，页面不留模糊层
  useEffect(() => () => onTyping(false), [onTyping]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft;
    const held = pics;
    rlog(`notes submit len=${text.length} trim=${text.trim().length} pics=${held.length}`);
    if (text.trim() === '' && held.length === 0) return;
    setDraft('');
    setPics([]);
    input.current?.blur();
    let r: ImagesResult;
    try {
      r = held.length > 0 ? await onImages(text, held.map((p) => p.file)) : { ok: await onAdd(text), left: [] };
    } catch (err) {
      rlog(`notes add threw ${errName(err)}`);
      r = { ok: false, left: held.map((p) => p.file) };
    }
    rlog(`notes add ${r.ok ? 'ok' : 'failed'}`);
    if (!r.ok) setDraft((d) => (d.trim() === '' ? text : d));
    const back = held.filter((p) => r.left.includes(p.file));
    if (back.length > 0) setPics((ps) => [...back, ...ps]);
  };
  const pick = (file: File) => {
    seq.current += 1;
    const key = seq.current;
    setPics((ps) => [...ps, { key, file }]);
  };
  return (
    <>
      {tip || pics.length > 0 ? (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- mousedown 只拦失焦（同下面 form，台账 Q-25），不是交互
        <div className={styles.above} onMouseDown={keepFieldFocus}>
          {tip}
          {pics.length > 0 ? <PendingPics pics={pics} onRemove={(key) => setPics((ps) => ps.filter((p) => p.key !== key))} /> : null}
        </div>
      ) : null}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- mousedown 只拦失焦（台账 Q-25，platform/viewport.ts 的 keepFieldFocus），不是交互，键盘操作不受影响 */}
      <form className={styles.inrow} onSubmit={(e) => void submit(e)} onMouseDown={keepFieldFocus} data-testid="notes-input-row">
        <input
          ref={input}
          className={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('notes.input', {})}
          aria-label={t('notes.inputLabel', {})}
          enterKeyHint="done"
          onTouchStart={inPlaceTouchStart}
          onTouchEnd={inPlaceTouchEnd}
          onFocus={() => onTyping(true)}
          onBlur={() => onTyping(false)}
          data-testid="notes-input"
        />
        <PickButtons onFile={pick} className={styles.img} idPrefix="notes" camera={false} />
        {has ? (
          <Pressable type="submit" className={styles.add} data-testid="notes-add">
            {t('notes.add', {})}
          </Pressable>
        ) : null}
      </form>
    </>
  );
}

/** 输入行打的字和待记下的小图（seq 是小图的编号，跟着一起留，重挂以后不和已有的撞）：页面拿着，传给 InputRow 的 state */
export function useInputDraft() {
  const [draft, setDraft] = useState('');
  const [pics, setPics] = useState<readonly PendingPic[]>([]);
  const seq = useRef(0);
  return { draft, setDraft, pics, setPics, seq };
}

export type InputDraft = ReturnType<typeof useInputDraft>;
