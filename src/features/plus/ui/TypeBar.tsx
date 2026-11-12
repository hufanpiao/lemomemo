// 打字条（B3 任务单 S2、FA-2；定稿线框“点一下＋打字”；R-353）
// • 贴键盘上沿，打开就聚焦；边打边预览“会记成这样”；回车或“记下”保存
// • 下滑把手 / “收起” / Esc：已打的字留草稿再关（“已记下”提示条还在时只收打字条、提示条留着，负责人 11-12 定）；“展开编辑”：把字和日历页选中的那天交给调用方开完整新建页
// • 过去的月日：出确认行“补记 / 记到”，选了才保存；关掉确认行时输入条里只留等确认那条的原文（同一句里已经存了的去掉），
//   去不干净时原话整句留着，输入条上方提示“同一句里其他几条已经记下了”（主持人 11-07 定）
// • 打字条开着时，“已记下 · 撤销”提示条抬到打字条上方（负责人 11-11 选“现在就挪到打字条上方”：原来两者都贴 --dock-bottom，提示条被打字条压住、点不到）：
//   ResizeObserver 量打字条高度，写进提示条外壳（display: contents）的 --type-lift（CSSOM，不是内联 style 属性，CSP 照样过），
//   提示条只用 transform 往上抬“打字条高 + LIFT_GAP_PX”；打字条变高（确认行、两行提示）跟着走，收起（folded）后回到底栏上方。
//   位置变化 110ms（calc(var(--dur-ui) / 2)）ease-out、只动 transform，系统或 App 里“减少动态”时直接到位（TypeBar.module.css .noticeSlot）
// • 记下后自动收起（R-392）：没剩字、没等确认的，收键盘、收打字条，只留“已记下 · 撤销”提示条；再点“＋”重新打开
// • 保存后的“已记下 · 撤销”用 kit 的 UndoToast（和撤销条同一套磨砂，R-122）；提示条还在时 Ctrl+Z 撤销这一批（S24），
//   焦点在有字的输入框里时让给浏览器撤销打字
// • 点页面空白处（Q-10 / R-390，11-11 负责人“没有输入内容，点空白处的话那个输入框应该直接消失”；已打字时选“保留输入框不动”）：
//   打字条开着时页面整个盖在后面那层液态玻璃（Mist，R-399）下面，“点空白”就是点这一层（它自己的 click，不另挂全局监听）：
//   没打字（去掉空白后为空）→ 等同点“收起”，打字条直接消失（负责人弹窗定“照原话直接消失”）；打了字 → 只让输入框失焦收键盘，打字条和字都留着。
//   “已记下 · 撤销”提示条开着时也照样收起打字条：提示条挪到打字条外面单独留着（folded：只是不画打字条，状态还在），
//   照常显示满 8 秒、仍可撤销，位置在 --dock-bottom（底栏上方；键盘已收起，不冲突）；提示条没了（到时、撤销、关闭）才真正 onClose。
//   收起后再点“＋”：App 每次打开带新的 opened 序号，序号变了就重新画出打字条并聚焦。
//   用 click 不用 pointerup：click 是一次点按的最后一个事件，处理时这一层还在，卸掉以后不会再有事件落到后面看不清的按钮上（不点穿）；
//   拖动、滚动浏览器本来就不发 click。底栏、“＋”、提示条、打字条都在这一层上面，点它们照原来的行为
//   确认行（补记 / 记到）、正在整理时只收键盘不收起：手上还有没落定的内容（原话、等确认那条），按负责人“有字时保留输入框不动”处理
// • 聚焦一律原地聚焦（台账 Q-8，platform/viewport.ts 文件头）：iPhone 上系统为了露出输入框会把页面滚一段，滚过以后光标画到“展开编辑”左边；
//   打开时 focusInPlace，输入框挂 inPlaceTouchStart / inPlaceTouchEnd（没聚焦时的一下点改成原地聚焦）。打字条贴键盘照旧靠 --dock-bottom
// • form 挂 onMouseDown={keepFieldFocus}（台账 Q-25）：按钮上按下不让输入框失焦，键盘不收、按钮不挪，“记下”等第一下就点得动；
//   “收起”（close）自己先 blur 收键盘，“展开编辑”关掉打字条、输入框跟着卸掉，记下后自动收起照旧 blur
// • 打字条后面的整页液态玻璃（R-399，负责人 11-11“按+出现的输入框之外的后面背景全做成液态模糊玻璃”，11-12 定中档 16px、点模糊处收起）：
//   打字条画着就画这一层，收起（folded）或关掉就没；组件和样式是 kit 的 Mist（和随手记 R-401 共用），层级 --z-mist；点它见上面“点页面空白处”。
//   出现、消失各记一行运行日志 typebar mist on/off（只记状态和实际生效的滤镜）
// • 文字一律经 t()（A20）；按钮用 kit 的 FormButton，输入框用 kit Form 的 .input（G11 输入框令牌、触屏 16px）
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { FormButton } from '../../../kit/components/Form.tsx';
import form from '../../../kit/components/Form.module.css';
import { Mist } from '../../../kit/components/Mist.tsx';
import { useKeys } from '../../../kit/hooks/useKeys.ts';
import { opensKeyboard } from '../../../platform/env.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { focusInPlace, inPlaceTouchEnd, inPlaceTouchStart, keepFieldFocus } from '../../../platform/viewport.ts';
import { usePlusLine, usePlusT } from '../hooks/usePlusT.ts';
import { useTypeBar, type CallAi, type TypeBarState, type Writer } from '../hooks/useTypeBar.ts';
import { ConfirmRow } from './ConfirmRow.tsx';
import { SavedNotice } from './SavedNotice.tsx';
import styles from './TypeBar.module.css';

/** 按住“＋”（B3 FA-3）：手势判定 hold 跟打字条同一块下载，app/plus-slot.tsx 拿去接到 GlassBar 的转发桥上；
 *  TypeBarPreload（小气泡 + 录音那一套）也从这一块转出去（app/plus-slot.tsx 直接挂 Preload），录音那一套再由它按需加载（RecordHost）：
 *  这样首屏的预加载表只有打字条这一处、不多出新文件名（首屏额度只剩约 90 B），录音和打字条共用的模块留在这一块里不重复 */
export { hold } from '../hooks/voice-sink.ts';
export { default as Preload } from './TypeBarPreload.tsx';

/** 下滑多少（px）算收起 */
export const SWIPE_CLOSE_PX = 40;
/** 打字条开着时提示条和打字条顶端之间留的空（px） */
export const LIFT_GAP_PX = 8;
/** 手上还有没落定的内容（打了字、确认行在问、正在整理）：点空白、记下后都只收键盘，不收起打字条 */
const unsettled = (s: TypeBarState): boolean => s.text.trim() !== '' || s.asking !== null || s.status === 'organizing';


/** 提示条跟着打字条顶端走：量打字条高度写进外壳的 --type-lift；收起了就清掉（回到底栏上方） */
function useLift(bar: RefObject<HTMLFormElement | null>, folded: boolean): RefObject<HTMLDivElement | null> {
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    const box = slot.current;
    if (!box) return undefined;
    if (folded || !el) {
      box.style.removeProperty('--type-lift');
      return undefined;
    }
    const put = (): void => box.style.setProperty('--type-lift', `${Math.round(el.getBoundingClientRect().height) + LIFT_GAP_PX}px`);
    put();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(put);
    ro.observe(el);
    return () => ro.disconnect();
  }, [bar, folded]);
  return slot;
}

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
  /** 第几次点“＋”打开（App 每次打开加 1）：变了就把收起的打字条重新画出来（Q-10） */
  opened?: number | undefined;
  onClose(): void;
}

const dayOf = (it: AiItem): string => {
  const d = it.kind === 'event' ? it.date : it.due;
  return [d ? d.slice(5) : '', it.time ?? ''].filter(Boolean).join(' ');
};

/** 焦点在有字的输入框、文本框，或可编辑区里：Ctrl+Z 让给浏览器撤销打字 */
function hasTyping(el: EventTarget | null): boolean {
  if (!opensKeyboard(el)) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value !== '';
  return el.isContentEditable;
}

export default function TypeBar({ day, callAi, writer, online, onExpand, onEdit, opened, onClose }: TypeBarProps) {
  const t = usePlusT();
  const line = usePlusLine();
  const s = useTypeBar({ day, callAi, writer, online });
  const input = useRef<HTMLInputElement>(null);
  const startY = useRef<number | null>(null);

  // 收起了打字条、只留提示条（Q-10）：再点“＋”展开；提示条没了就真正关掉
  // 收起时记下当时的 opened；渲染时直接算（不用 effect 重置）：再点“＋”opened 一变，同一次渲染就展开，
  // 聚焦和第一次打开一样在点按的同一个任务里完成（iOS 只在手势里 focus 才弹键盘；独立验证 11-11 必改 1）
  const [foldedAt, setFoldedAt] = useState<number | null>(null);
  const folded = foldedAt !== null && foldedAt === (opened ?? 0);
  // 点空白的监听只挂一次，收起时要拿最新的 opened：放 ref 里，setFolded 保持同一个函数
  const openedNow = useRef(opened);
  openedNow.current = opened;
  const setFolded = useCallback((): void => setFoldedAt(openedNow.current ?? 0), []);
  useLayoutEffect(() => {
    if (!folded) focusInPlace(input.current, 'open');
  }, [folded]);
  const bar = useRef<HTMLFormElement>(null);
  /** 收起（“收起”、Esc、下滑、点模糊处、记下后自动收起都走这一个；负责人 11-12 选“统一成留着提示条”）：先收键盘（form 拦了按钮上的失焦，Q-25）；
   *  “已记下 · 撤销”提示条还在：只收打字条，提示条留满 8 秒、仍可撤销，字留在状态里，提示条没了由下面的 effect 留草稿再真正关；
   *  没有提示条：已打的字留草稿再关 */
  const close = (): void => {
    input.current?.blur();
    if (s.notice) setFolded();
    else void s.stash().then(onClose);
  };
  const live = useRef({ s, close });
  live.current = { s, close };
  const slot = useLift(bar, folded);
  useEffect(() => {
    if (folded && !s.notice) live.current.close();
  }, [folded, s.notice]);
  // 记下后自动收起（R-392，负责人 11-11“记下一条后那个输入框不需要放在那边，还要我点收起才能收掉”）：
  // 新出一条“已记下”提示、手上没剩字也没等确认的 → 收键盘、收打字条，只留提示条；有剩的照旧留着
  useEffect(() => {
    const cur = live.current.s;
    if (!cur.notice || unsettled(cur)) return;
    live.current.close();
  }, [s.notice]);
  useKeys({
    'mod+z': (e) => {
      if (!s.notice) return false;
      if (hasTyping(e.target)) return false;
      void s.undo();
      return true;
    },
  });

  /** 点后面那层液态玻璃 = 点页面空白处（Q-10）：手上有没落定的只收键盘，别的等同“收起” */
  const tapMist = (): void => {
    if (unsettled(s)) input.current?.blur();
    else close();
  };
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
      {folded ? null : (
        <>
          <Mist onTap={tapMist} tag="typebar" log={rlog} testId="type-mist" />
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- mousedown 只拦失焦（台账 Q-25，platform/viewport.ts 的 keepFieldFocus），不是交互，键盘操作不受影响 */}
          <form ref={bar} className={styles.bar} onSubmit={onSubmit} onMouseDown={keepFieldFocus} aria-label={t('plus.type.label', {})} data-testid="type-bar">
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
                    onTouchStart={inPlaceTouchStart}
                    onTouchEnd={inPlaceTouchEnd}
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
        </>
      )}
      <div ref={slot} className={styles.noticeSlot}>
        {s.notice ? (
          <SavedNotice
            text={s.notice.lines.map((l) => line(l.key, l.params)).join(' · ')}
            rows={s.notice.entries.map((e) => ({ table: e.ref.table, id: e.ref.id, label: `${kind(e.item)} · ${e.ref.title}` }))}
            onUndoAll={() => void s.undo()}
            onUndoOne={(id) => void s.undoOne(id)}
            onMerge={() => void s.merge()}
            onEdit={onEdit}
            onClose={s.closeNotice}
          />
        ) : null}
      </div>
    </>
  );
}
