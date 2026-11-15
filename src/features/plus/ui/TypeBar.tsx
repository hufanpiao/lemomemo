// 打字条（B3 任务单 S2、FA-2；定稿线框“点一下＋打字”；R-353）
// • 贴键盘上沿，打开就聚焦；边打边预览“会记成这样”；回车或“记下”保存
// • 下滑把手 / “收起” / Esc：已打的字留草稿再关（“已记下”提示条还在时只收打字条、提示条留着，负责人 11-12 定）；“展开编辑”：把字和日历页选中的那天交给调用方开完整新建页
// • 收起只有一个入口 settle(reason)（前端-17）：收起按钮、Esc、下滑、点空白（没打字）、记下后自动收起、查找、判成别的意图、展开编辑、换页（App 卸掉）
//   都走它，收键盘、草稿（DRAFT 表：留 / 清 / 不动）、只收打字条还是真正关、运行日志 typebar settle reason= fold=0|1|end 都在这一处；
//   换页原来什么都不做（打的字丢了），判成查找后提示条到时原来会写空草稿删掉 toAssist 写的原话，两处都按表改成和别的路一致
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
//   确认行（补记 / 记到）、正在整理时只收键盘不收起：手上还有没落定的内容（原话、等确认那条），按负责人“有字时保留输入框不动”处理。
//   每次点都记一行运行日志 typebar blank act=blur|close len= asking= status=（只记字数，不记字）
// • 聚焦一律原地聚焦（台账 Q-8，platform/viewport.ts 文件头）：iPhone 上系统为了露出输入框会把页面滚一段，滚过以后光标画到“展开编辑”左边；
//   打开时 focusInPlace，输入框挂 inPlaceTouchStart / inPlaceTouchEnd（没聚焦时的一下点改成原地聚焦）。打字条贴键盘照旧靠 --dock-bottom
// • form 挂 onMouseDown={keepFieldFocus}（台账 Q-25）：按钮上按下不让输入框失焦，键盘不收、按钮不挪，“记下”等第一下就点得动；
//   收起（settle）自己先 blur 收键盘，“展开编辑”关掉打字条、输入框跟着卸掉，记下后自动收起照旧 blur
// • 打字条后面的整页液态玻璃（R-399，负责人 11-11“按+出现的输入框之外的后面背景全做成液态模糊玻璃”，11-12 定中档 16px、点模糊处收起）：
//   打字条画着就画这一层，收起（folded）或关掉就没；组件和样式是 kit 的 Mist（和随手记 R-401 共用），层级 --z-mist；点它见上面“点页面空白处”。
//   出现、消失各记一行运行日志 typebar mist on/off（只记状态和实际生效的滤镜）
// • 按“记下”后等 AI 拆分（最多 PARSE_TIMEOUT_MS，超时照旧用本机规则）期间，预览行换成“正在识别…”（负责人 11-13 弹窗定 Q-27 选乙“照旧等 AI，加提示”，R-406）；
//   “记下”照旧灰着、不能连点。开始、结束和耗时记在 useTypeBar 的 typebar recog on/off
// • 看起来是要查找（B4b-2，线框 sPlus“点按＋打字：预览先显示查找”；判断在 useTypeBar 的 find）：输入框上方出“看起来是要查找 · Enter 查找”和“找：…”一张卡，
//   按钮变“查找”，回车或按钮打开查找面板（useTypeBar 的 openFind → hooks/assist-open 的 toAssist → smart-search 的 openAssist）、清掉这句字、收起打字条（有提示条时只收打字条）；
//   点“找：…”那张卡 = 改成记下（这一句照旧记下，下面一行提示怎么改）。运行日志 typebar find len=（只记字数）
// • 文字一律经 t()（A20）；按钮用 kit 的 FormButton，输入框用 kit Form 的 .input（G11 输入框令牌、触屏 16px）
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject, type FormEvent, type PointerEvent } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { FormButton } from '../../../kit/components/Form.tsx';
import form from '../../../kit/components/Form.module.css';
import { Mist } from '../../../kit/components/Mist.tsx';
import { useKeys } from '../../../kit/hooks/layers.ts';
import { useLayer } from '../../../kit/hooks/useLayer.ts';
import { opensKeyboard } from '../../../platform/env.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { focusInPlace, inPlaceTouchEnd, inPlaceTouchStart, keepFieldFocus } from '../../../platform/viewport.ts';
import { usePlusT } from '../hooks/usePlusT.ts';
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

/** 打字条收起的由来（settle 的 reason，运行日志 typebar settle reason=…）：
 *  button 点“收起”、esc、swipe 下滑把手、blank 没打字点空白、saved 记下后自动收起、find 回车查找、asked 判成别的意图交给结果层、
 *  expand “展开编辑”、route 换页（App 直接卸掉打字条） */
export type SettleReason = 'button' | 'esc' | 'swipe' | 'blank' | 'saved' | 'find' | 'asked' | 'expand' | 'route';
/** 各由来的草稿：keep 留已打的字（空串即删）；drop 清掉（字带去新建页了）；none 不动（原话已经由 toAssist 写进草稿） */
const DRAFT: Record<SettleReason, 'keep' | 'drop' | 'none'> = {
  button: 'keep', esc: 'keep', swipe: 'keep', blank: 'keep', saved: 'keep', route: 'keep', find: 'none', asked: 'none', expand: 'drop',
};


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

/**
 * 把手往下滑 SWIPE_CLOSE_PX 以上松开就收起。抓住指针（第三方审查前端-18）：手指滑出把手再松开也收得到 up；
 * 被系统打断（pointercancel）就清掉起点，免得下次点一下按旧起点误收起
 */
function useGripClose(close: () => void) {
  const startY = useRef<number | null>(null);
  return {
    down(e: PointerEvent) {
      startY.current = e.clientY;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // 指针已经没了：照旧，收不到 up 时由 cancel 或下次按下重置
      }
    },
    up(e: PointerEvent) {
      if (startY.current !== null && e.clientY - startY.current >= SWIPE_CLOSE_PX) close();
      startY.current = null;
    },
    cancel() {
      startY.current = null;
    },
  };
}

interface SettleDeps {
  s: TypeBarState;
  folded: boolean;
  setFolded(): void;
  input: RefObject<HTMLInputElement | null>;
  day: DateStr | null;
  onExpand(text: string, day: DateStr | null): void;
  onClose(): void;
}

/** 收起打字条的唯一入口 settle(reason)（前端-17；负责人 11-12 选“统一成留着提示条”）：先收键盘（form 拦了按钮上的失焦，Q-25；焦点不由层栈还）；
 *  “已记下 · 撤销”提示条还在（展开编辑、换页除外，页面要走了）：只收打字条，提示条留满 8 秒、仍可撤销，字留在状态里，提示条没了按同一由来收尾；
 *  没有提示条：按由来处理草稿（DRAFT）再关。每次记一行 typebar settle reason= fold=0|1，收尾时 fold=end（只记由来，不记字）。
 *  App 换页直接卸掉打字条时，没走过 settle 的按 route 收 */
function useSettle(d: SettleDeps): (reason: SettleReason) => void {
  /** 只收了打字条时记着由来；已经 onClose / onExpand 过就是 done（App 随后卸掉时不再按 route 收一次） */
  const pending = useRef<SettleReason>('button');
  const done = useRef(false);
  const finish = (reason: SettleReason): void => {
    done.current = true;
    const how = DRAFT[reason];
    if (how === 'drop') d.s.dropDraft();
    const after = (): void => {
      if (reason === 'expand') d.onExpand(d.s.text, d.day);
      else if (reason !== 'route') d.onClose();
    };
    // route：没打字不写（空串会删掉已有草稿；StrictMode 挂上又卸的那一下也走这里）
    if (how === 'keep' && !(reason === 'route' && d.s.text.trim() === '')) void d.s.stash().then(after);
    else after();
  };
  const settle = (reason: SettleReason): void => {
    const fold = d.s.notice !== null && reason !== 'expand' && reason !== 'route';
    rlog(`typebar settle reason=${reason} fold=${fold ? 1 : 0}`);
    d.input.current?.blur();
    pending.current = reason;
    if (fold) d.setFolded();
    else finish(reason);
  };
  const live = useRef({ settle, finish });
  live.current = { settle, finish };
  const { folded } = d;
  const notice = d.s.notice !== null;
  useEffect(() => {
    if (!folded || notice) return;
    rlog(`typebar settle reason=${pending.current} fold=end`);
    live.current.finish(pending.current);
  }, [folded, notice]);
  // 挂上时重置 done：StrictMode 卸了又挂的那一下不算收起过
  useEffect(() => {
    done.current = false;
    return () => {
      if (!done.current) live.current.settle('route');
    };
  }, []);
  return settle;
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
  const s = useTypeBar({ day, callAi, writer, online, onAsked: () => live.current.settle('asked') });
  const input = useRef<HTMLInputElement>(null);

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
  const settle = useSettle({ s, folded, setFolded, input, day, onExpand, onClose });
  const live = useRef({ s, settle });
  live.current = { s, settle };
  const slot = useLift(bar, folded);
  // 记下后自动收起（R-392，负责人 11-11“记下一条后那个输入框不需要放在那边，还要我点收起才能收掉”）：
  // 新出一条“已记下”提示、手上没剩字也没等确认的 → 收键盘、收打字条，只留提示条；有剩的照旧留着。
  // 也看 status：提示条在存成那一刻就出来（那时还在“正在整理”、字也还在），收尾（done）时提示条没换，靠 status 变了再看一次
  useEffect(() => {
    const cur = live.current.s;
    if (!cur.notice || unsettled(cur)) return;
    live.current.settle('saved');
  }, [s.notice, s.status]);
  useKeys({
    'mod+z': (e) => {
      if (!s.notice) return false;
      if (hasTyping(e.target)) return false;
      void s.undo();
      return true;
    },
  });

  /** 点后面那层液态玻璃 = 点页面空白处（Q-10 / R-390）：手上有没落定的只收键盘，别的等同“收起”。
   *  记一行 typebar blank act=blur|close（只记字数、确认行在不在、状态，不记字），以后靠日志看点空白走了哪一支 */
  const tapMist = (): void => {
    const keep = unsettled(s);
    rlog(`typebar blank act=${keep ? 'blur' : 'close'} len=${s.text.trim().length} asking=${s.asking ? 1 : 0} status=${s.status}`);
    if (keep) input.current?.blur();
    else settle('blank');
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (s.find !== null) {
      s.openFind();
      settle('find');
      return;
    }
    void s.submit();
  };
  // 打字条画着（没收起）就是层栈里的一层（kit/hooks/layers.ts，非模态）：Esc 只在它是栈顶时收起，外面的详情抽屉不跟着关（独立评审第 1 条）；
  // 焦点不由层栈还（收起时 settle 自己收键盘）
  useLayer(!folded, { name: 'typebar', onEsc: () => live.current.settle('esc'), back: () => [] });
  const grip = useGripClose(() => settle('swipe'));

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
            <div className={styles.grip} onPointerDown={grip.down} onPointerUp={grip.up} onPointerCancel={grip.cancel} aria-hidden="true" />
            {s.asking ? (
              <ConfirmRow item={s.asking} onChoose={(c) => void s.choose(c)} onDismiss={s.dismissConfirm} />
            ) : (
              <>
                {s.partSaved ? (
                  <div className={styles.preview} role="status" data-testid="type-part-saved">{t('plus.type.partSaved', {})}</div>
                ) : null}
                {s.find !== null ? (
                  <>
                    <div className={styles.preview} data-testid="type-find-head">{t('plus.type.findHead', {})}</div>
                    <button type="button" className={styles.find} onClick={s.keepRecord} data-testid="type-find">
                      <span className={styles.findIcon} aria-hidden="true" />
                      <span className={styles.findText}>
                        <span>{t('plus.type.findQ', { q: s.find })}</span>
                        <span className={styles.findSub}>{t('plus.type.findWhere', {})}</span>
                      </span>
                    </button>
                  </>
                ) : null}
                <div className={styles.row}>
                  <input
                    ref={input}
                    className={form.input}
                    value={s.text}
                    onChange={(e) => s.setText(e.target.value)}
                    onTouchStart={inPlaceTouchStart}
                    onTouchEnd={inPlaceTouchEnd}
                    placeholder={t('plus.type.ph', {})}
                    aria-label={t('plus.type.label', {})}
                    enterKeyHint="done"
                    data-testid="type-input"
                  />
                  <FormButton type="submit" variant="primary" disabled={s.text.trim() === '' || s.status === 'organizing'}>
                    {t(s.find !== null ? 'plus.type.find' : 'plus.type.save', {})}
                  </FormButton>
                </div>
                <div className={styles.preview} aria-live="polite" data-testid="type-preview">
                  {s.status === 'organizing'
                    ? t('plus.type.recognizing', {})
                    : s.find !== null ? t('plus.type.findAsRecord', {})
                    : first ? t('plus.type.preview', { text: s.preview.length > 1 ? `${previewText} · ${t('plus.type.more', { n: s.preview.length - 1 })}` : previewText }) : ''}
                </div>
                <div className={styles.row}>
                  <FormButton type="button" variant="ghost" onClick={() => settle('expand')}>{t('plus.type.expand', {})}</FormButton>
                  <FormButton type="button" variant="ghost" onClick={() => settle('button')}>{t('plus.type.close', {})}</FormButton>
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
        {s.notice ? <SavedNotice notice={s.notice} acts={s} onEdit={onEdit} /> : null}
      </div>
    </>
  );
}
