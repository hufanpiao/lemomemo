// 打字条（点一下“＋”打字）
// • 贴键盘上沿，打开就聚焦；输入框下面一排签（分类、日期、提醒，ui/PlusFields.tsx）边打边填识别结果、能点着改，签就是预览；回车或“记下”保存
// • 下滑把手 / “收起” / Esc：已打的字留草稿再关；“展开编辑”：把字和日历页选中的那天交给调用方开完整新建页
// • 收起只有一个入口 settle(reason)（useSettle）：收起按钮、Esc、下滑、点空白（没打字）、记下后自动收起、查找、判成别的意图、展开编辑、换页（App 卸掉）
//   都走它，收键盘、草稿、onClose、运行日志 typebar settle reason= 都在这一处；已经收过的再来一次只记 typebar settle skip reason=
//   草稿只看“这次打过字没有”（useTypeBar 的 stash）：打过字才写，没打过不碰——这一份草稿录音、quick-add、结果层也在写，不能拿空串删掉；展开编辑清掉。
// • 收起就是卸掉：“已记下 · 撤销”提示条和记下的这一批不在打字条里——这一批在模块里（data/type-batch.ts），
//   提示条外挂在 ui/TypeNotice.tsx（TypeBarPreload 里一直挂着），打字条收起、卸掉以后照常满 8 秒、仍可撤销；
//   再点“＋”（结果层点“改”也是）重新挂上，挂上时重读草稿（refill），没打过字时填回
// • 过去的月日：出确认行“补记 / 记到”，选了才保存；关掉确认行时输入条里只留等确认那条的原文（同一句里已经存了的去掉），
//   去不干净时原话整句留着，输入条上方提示“同一句里其他几条已经记下了”
// • 打字条开着时，“已记下 · 撤销”提示条抬到打字条上方：打字条用 TypeNotice 的 useNoticeLift
//   量自己的高度报给提示条，卸掉就清掉、提示条回到底栏上方（见 ui/TypeNotice.tsx 文件头）
// • 记下后自动收起：这一句（连同确认行选完的）都存好了，收键盘、收打字条，只留“已记下 · 撤销”提示条；再点“＋”重新打开
// • 点页面空白处：打字条开着时页面整个盖在后面那层液态玻璃（Mist）下面，“点空白”就是点这一层（它自己的 click，不另挂全局监听）：
//   没打字（去掉空白后为空）→ 等同点“收起”，打字条直接消失；打了字 → 只让输入框失焦收键盘，打字条和字都留着。
//   “已记下 · 撤销”提示条开着时也照样收起打字条：提示条在外面（TypeNotice）单独留着，位置在 --dock-bottom（底栏上方；键盘已收起，不冲突）。
//   用 click 不用 pointerup：click 是一次点按的最后一个事件，处理时这一层还在，卸掉以后不会再有事件落到后面看不清的按钮上（不点穿）；
//   拖动、滚动浏览器本来就不发 click。底栏、“＋”、提示条、打字条都在这一层上面，点它们照原来的行为
//   确认行（补记 / 记到）、正在整理时只收键盘不收起：手上还有没落定的内容（原话、等确认那条），同“有字时保留输入框不动”。
//   每次点都记一行运行日志 typebar blank act=blur|close len= asking= status=（只记字数，不记字）
// • 贴底浮条的原地聚焦（规则在 platform/in-place-focus.ts 文件头）：打开时 focusInPlace，输入框挂 inPlaceTouchStart / inPlaceTouchEnd，form 挂 keepFieldFocus。
//   打字条贴键盘照旧靠 --dock-bottom；收起（settle）自己先 blur 收键盘，“展开编辑”关掉打字条、输入框跟着卸掉，记下后自动收起照旧 blur
// • 打字条后面的整页液态玻璃（中档 16px，点它收起）：打字条挂着就画这一层，收起（卸掉）就没；组件和样式是 kit 的 Mist（和随手记共用），层级 --z-mist；
//   点它见上面“点页面空白处”。出现、消失各记一行运行日志 typebar mist on/off（只记状态和实际生效的滤镜）
// • 按“记下”后等 AI 拆分（最多 PARSE_TIMEOUT_MS，超时照旧用本机规则）期间，预览行换成“正在识别…”；
//   “记下”照旧灰着、不能连点。开始、结束和耗时记在 useTypeBar 的 typebar recog on/off
// • 看起来是要查找（判断在 useTypeBar 的 find）：输入框上方出“看起来是要查找 · Enter 查找”和“找：…”一张卡，
//   按钮变“查找”，回车或按钮打开查找面板（useTypeBar 的 openFind → hooks/assist-open 的 toAssist → smart-search 的 openAssist）、清掉这句字、收起打字条；
//   点“找：…”那张卡 = 改成记下（这一句照旧记下，下面一行提示怎么改）。运行日志 typebar find len=（只记字数）
// • 文字一律经 t()
// • 样子（无框撰写卡）：输入区不画框、聚焦不画全站 2px 聚焦框，只看光标；
//   底下一条工具行（上面 0.5px 细线）：左边“展开编辑”“收起”两枚 44×44 图标按钮（aria-label + title 照旧是这两个字），右边“记下”胶囊——没打字灰、打了字柠檬黄
//   （签点亮也用柠檬黄 --chip-on-bg）；状态行（正在识别、查找改法）有字才占位（空了 :empty 不占）。下滑把手不画出来，改成卡片顶边一条透明的拖动起点
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, type RefObject, type FormEvent, type PointerEvent } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import float from '../../../kit/components/Float.module.css';
import { Mist } from '../../../kit/components/Mist.tsx';
import { useLayer } from '../../../kit/hooks/useLayer.ts';
import { Pressable } from '../../../motion/components.ts';
import { probeCaret } from '../../../platform/caret-probe.ts';
import { holdForKeyboard } from '../../../platform/kb-hint.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { MascotPeek } from '../../mascot/index.ts';
import { focusInPlace, inPlaceTouchEnd, inPlaceTouchStart, keepFieldFocus } from '../../../platform/in-place-focus.ts';
import { usePlusT } from '../hooks/usePlusT.ts';
import { useTypeBar, type CallAi, type HandOff, type TypeBarState, type Writer } from '../hooks/useTypeBar.ts';
import { ConfirmRow } from './ConfirmRow.tsx';
import { PlusFields } from './PlusFields.tsx';
import { useNoticeLift } from './TypeNotice.tsx';
import styles from './TypeBar.module.css';

/** 按住“＋”：手势判定 hold 跟打字条同一块下载，app/plus-slot.tsx 拿去接到 GlassBar 的转发桥上；
 *  TypeBarPreload（小气泡 + 录音那一套）也从这一块转出去（app/plus-slot.tsx 直接挂 Preload），录音那一套再由它按需加载（RecordHost）：
 *  这样首屏的预加载表只有打字条这一处、不多出新文件名（首屏额度只剩约 90 B），录音和打字条共用的模块留在这一块里不重复 */
export { hold } from '../hooks/voice-sink.ts';
export { default as Preload, loadRecordHost } from './TypeBarPreload.tsx';
// exe 快速记录框交来的一句：app/plus-slot.tsx 下载好这一块时订阅一次（整页一份，不跟着 RecordHost 挂卸）
export { listenQuickAdd } from '../hooks/voice-main.ts';

/** 下滑多少（px）算收起 */
export const SWIPE_CLOSE_PX = 40;
/** 手上还有没落定的内容（打了字、确认行在问、正在整理）：点空白只收键盘，不收起打字条 */
const unsettled = (s: TypeBarState): boolean => s.text.trim() !== '' || s.asking !== null || s.status === 'organizing';

/** 打字条收起的由来（settle 的 reason，运行日志 typebar settle reason=…）：
 *  button 点“收起”、esc、swipe 下滑把手、blank 没打字点空白、saved 记下后自动收起、find 回车查找、asked 判成别的意图交给结果层、ai 点“问 AI”
 *  （这三种由 useTypeBar 经 onAsked 交来）、expand “展开编辑”、route 换页（App 直接卸掉打字条） */
export type SettleReason = 'button' | 'esc' | 'swipe' | 'blank' | 'saved' | HandOff | 'expand' | 'route';

export interface TypeBarProps {
  /** 日历页选中的那天；别的页为 null */
  day: DateStr | null;
  callAi?: CallAi;
  writer?: Writer;
  online?: () => boolean;
  /** 展开成完整新建页：带上已打的字和选中的日子 */
  onExpand(text: string, day: DateStr | null): void;
  /** 提示条里“修改”某一条：开它的编辑页（不给就不显示“修改”；交给外挂的提示条，见 data/type-batch.ts） */
  onEdit?: (table: string, id: string) => void;
  onClose(): void;
}

/**
 * 把手往下滑 SWIPE_CLOSE_PX 以上松开就收起。抓住指针：手指滑出把手再松开也收得到 up；
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
  input: RefObject<HTMLInputElement | null>;
  day: DateStr | null;
  onExpand(text: string, day: DateStr | null): void;
  onClose(): void;
}

/** 收起打字条的唯一入口 settle(reason)；收起就是卸掉，提示条不在这里（见文件头）：
 *  • 先收键盘（form 拦了按钮上的失焦；焦点不由层栈还）
 *  • 展开编辑：清草稿、交给 onExpand（App 等“详细”长成新建页再卸掉打字条）；别的打过字才留草稿（stash），再 onClose（换页时 App 已经卸了，不再调）
 *  • 已经收过再来一次：只记 typebar settle skip（连点）
 *  • 换页：App 直接卸掉，没收过的按 route 收；没打过字直接返回（StrictMode 挂上又卸的那一下也是这样），不记日志、不收键盘
 *  返回的 settle 一直是同一个函数（里面拿最新的状态；这里是打字条唯一一份“拿最新闭包”的 ref） */
function useSettle(d: SettleDeps): (reason: SettleReason) => void {
  const done = useRef(false);
  const live = useRef(d);
  live.current = d;
  const settle = useCallback((reason: SettleReason): void => {
    const { s, input, day, onExpand, onClose } = live.current;
    if (done.current) {
      rlog(`typebar settle skip reason=${reason}`);
      return;
    }
    if (reason === 'route' && !s.dirty()) return;
    done.current = true;
    rlog(`typebar settle reason=${reason}`);
    input.current?.blur();
    if (reason === 'expand') {
      s.dropDraft();
      onExpand(s.text, day);
      return;
    }
    void s.stash().then(() => {
      if (reason !== 'route') onClose();
    });
  }, []);
  // 挂上时重置 done：StrictMode 卸了又挂的那一下不算收过；已经收过的卸掉不再记一次
  useEffect(() => {
    done.current = false;
    return () => {
      if (!done.current) settle('route');
    };
  }, [settle]);
  return settle;
}

export default function TypeBar({ day, callAi, writer, online, onExpand, onEdit, onClose }: TypeBarProps) {
  const t = usePlusT();
  // 判成查找、交给结果层（useTypeBar 的 handOff）、记下后自动收起也走 settle；settle 在下面才拿到，它一直是同一个函数，这里只在事件里调
  const s = useTypeBar({ day, callAi, writer, online, onEdit, onAsked: (r) => settle(r), onSaved: () => settle('saved') });
  const input = useRef<HTMLInputElement>(null);
  const settle = useSettle({ s, input, day, onExpand, onClose });
  // 先按上次的键盘高度就位，再聚焦（顺序不能反）：聚焦以后输入框不再移动，系统的光标才画得对（platform/kb-hint.ts）。
  // 挂上的那一次渲染里就聚焦（iOS 只在点按的同一个任务里 focus 才弹键盘）
  useLayoutEffect(() => holdForKeyboard(), []);
  useLayoutEffect(() => focusInPlace(input.current, 'open'), []);
  // 挂上就重读草稿（没打过字时填回；收起期间录音、结果层“改”写进去的原话不丢）
  const { refill } = s;
  useEffect(() => refill(), [refill]);
  const bar = useRef<HTMLFormElement>(null);
  useNoticeLift(bar);

  /** 点后面那层液态玻璃 = 点页面空白处：手上有没落定的只收键盘，别的等同“收起”。
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
      return;
    }
    void s.submit();
  };
  // 打字条挂着就是层栈里的一层（kit/hooks/layers.ts，非模态）：Esc 只在它是栈顶时收起，外面的详情抽屉不跟着关；
  // 焦点不由层栈还（收起时 settle 自己收键盘）
  useLayer(true, { name: 'typebar', onEsc: () => settle('esc'), back: () => [] });
  const grip = useGripClose(() => settle('swipe'));

  return (
    <>
      <Mist onTap={tapMist} tag="typebar" log={rlog} testId="type-mist" />
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- mousedown 只拦失焦（platform/in-place-focus.ts 的 keepFieldFocus），不是交互，键盘操作不受影响 */}
      <form ref={bar} className={`${float.float} ${styles.bar}`} onSubmit={onSubmit} onMouseDown={keepFieldFocus} aria-label={t('plus.type.label', {})} data-testid="type-bar">
        <div className={styles.grip} onPointerDown={grip.down} onPointerUp={grip.up} onPointerCancel={grip.cancel} aria-hidden="true" />
        <Suspense fallback={null}>
          <MascotPeek kind="plus" />
        </Suspense>
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
            <input
              ref={input}
              className={styles.field}
              value={s.text}
              onChange={(e) => s.setText(e.target.value)}
              onFocus={(e) => probeCaret(e.currentTarget)}
              onTouchStart={inPlaceTouchStart}
              onTouchEnd={inPlaceTouchEnd}
              placeholder={t('plus.type.ph', {})}
              aria-label={t('plus.type.label', {})}
              enterKeyHint="done"
              data-testid="type-input"
            />
            {/* 状态行：正在识别、查找时的改法；平时空着（aria-live 要先在），:empty 不占位。签就是预览 */}
            <div className={styles.say} aria-live="polite" data-testid="type-preview">
              {s.status === 'organizing' ? t('plus.type.recognizing', {}) : s.find !== null ? t('plus.type.findAsRecord', {}) : null}
            </div>
            {s.find !== null ? null : (
              <PlusFields fields={s.fields} typed={s.text.trim() !== ''} day={day} today={s.today} projects={s.projects} pick={s.pick} addProject={s.addProject} field={input} />
            )}
            {/* 工具行：图标按钮只有图标不好认，aria-label 给读屏、title 给电脑悬停；“记下”禁用时灰底灰字 */}
            <div className={styles.tools}>
              <Pressable className={styles.icon} onClick={() => settle('expand')} aria-label={t('plus.type.expand', {})} title={t('plus.type.expand', {})}>
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg>
              </Pressable>
              <Pressable className={styles.icon} onClick={() => settle('button')} aria-label={t('plus.type.close', {})} title={t('plus.type.close', {})}>
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6" /></svg>
              </Pressable>
              {/* “问 AI”：次要胶囊，在“记下”左边；点了这一句交给 AI 助手抽屉，不保存 */}
              <Pressable className={styles.askAi} onClick={s.askAi} disabled={s.text.trim() === '' || s.status === 'organizing'} data-testid="type-ask-ai">
                {t('plus.type.askAi', {})}
              </Pressable>
              <Pressable type="submit" className={styles.save} disabled={s.text.trim() === '' || s.status === 'organizing'}>
                {t(s.find !== null ? 'plus.type.find' : 'plus.type.save', {})}
              </Pressable>
            </div>
          </>
        )}
        {s.error ? (
          <div className={styles.err} role="alert">{t(s.error === 'nothing' ? 'plus.notice.nothing' : 'plus.notice.notSaved', {})}</div>
        ) : null}
      </form>
    </>
  );
}
