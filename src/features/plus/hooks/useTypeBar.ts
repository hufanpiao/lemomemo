// 打字条的状态和动作（点一下“＋”打字）
// • 输入框下面那排签（分类、日期、提醒，data/type-fields.ts）就是预览：边打边跑本机规则（planLocal，不带日历页的默认日子、不花 AI 次数）填签；
//   手点过的格子记在 picks 里，记下时 applyPicks 盖到本机或 AI 的结果上（手选优先、手选了日期不拆条）；记下、交给结果层后清掉。点签记 typebar pick k=（只记哪一格）
// • 回车 / “记下”：planText（额度、planTyped、剩余次数，和语音同一份）→ 没有要问的几条先存；有过去的月日的出确认行（confirming），选了才加进同一批；
//   没选就关掉 → 原话留在输入条（已经存了的几条照常在提示条上，能撤）
// • 保存经 data/saved-batch → data/capture-save（captureRow、batch_id、outbox）；没写进去：提示“没保存上”，输入框不清空
// • 下滑 / “收起”：这次打过字（typed）才把字存草稿（本机库 drafts 仓，按账号分），没打过不碰——同一份草稿录音、quick-add、结果层也在写；
//   挂上时 refill 读回来（没打过字时填回；收起就卸掉，再点“＋”是重新挂上）
// • “展开编辑”：把已打的字和日历页选中的那天交给调用方，打开完整新建页
// • callAi 默认是真的 ai-parse（data/ai-parse-api.ts）；设置里 ai.enabled 没开时不调，没把握的也直接用本机规则，不出“AI 没回应”
// • 提示条：一条 → “已记下：…”；多条 → “已记下 N 条”，展开逐条改、撤，“拆错了，合并成一条”“全部撤销”。
//   这一批在模块里（data/type-batch.ts），提示条外挂（ui/TypeNotice.tsx，useTypeNotice），不跟着打字条卸
// • 看起来是要查找（“看起来是要查找 · Enter 查找”）：本机规则 localIntent 判成查找、有把握、
//   没带时间范围、查询词不空 → find 给出查询词，界面换成“找：…”，回车打开查找面板（features/smart-search）；“改成记下”把这一句当记下。
//   没把握的、带时间范围的（“上周的会”“这个月的待办”）、总结、改期、完成：回车走 planText（本机或 AI 判意图），
//   判成别的意图的不保存：清掉输入条、交给结果层（hooks/assist-open 的 toAssist，同时把原话写进草稿），调用方 onAsked 收起打字条
//   （查找和判意图同一个出口 handOff，onAsked 带上由来 find / asked）
// • 点“问 AI”（askAi）：这一句不保存、不判意图，交给 AI 助手抽屉（hooks/assist-open 的 toChat，原话先写进草稿），清字、按由来 ai 收起
// • 等 AI 期间打字条被卸载（收起、切页）：这一次的请求当场中止，回来的结果丢掉——不写状态、不存、不打开结果层
//   （收起、切页时原话已经由 stash 写进草稿，下次打开填回；ui/TypeBar.tsx 的 settle）；日志 typebar submit dropped unmounted
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { todayOf, type DateStr } from '../../../../shared/core/date.ts';
import { remindAsked } from '../../../../shared/logic/parse/index.ts';
import { getBoot } from '../../../core/boot.ts';
import { currentTz } from '../../../core/current-tz.ts';
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';
import { FADE_WAIT_MS, whenMainShown } from '../../../motion/index.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { callAiParse } from '../data/ai-parse-api.ts';
import { captureStep, type CaptureEvent, type CaptureStatus } from '../data/capture-state.ts';
import type { Writer } from '../data/capture-save.ts';
import { clearTypeDraft, readTypeDraft, writeTypeDraft } from '../data/type-draft.ts';
import { bindTypeBatch, dropTypeNotice, typeBatch, typeNoticeOn, typeOnEdit } from '../data/type-batch.ts';
import { keepAsked, localHint, planLocal, planText, type CallAi } from '../data/type-flow.ts';
import { applyPicks, fieldsOf, type Picks } from '../data/type-fields.ts';
import { useCaptureCtx } from './useCaptureCtx.ts';
import { toAssist, toChat } from './assist-open.ts';

import { useSavedBatch } from './useSavedBatch.ts';
import { onlineNow } from '../../../platform/online.ts';

// ui 不能直接 import data，界面要用的类型经这里转出去
export type { CallAi } from '../data/type-flow.ts';
export type { Writer } from '../data/capture-save.ts';
export type { BatchEntry } from './useSavedBatch.ts';
export { dayChoices, DUR_CHOICES, SPAN_CHOICES, TIME_CHOICES, type DayChoice, type Fields, type FieldKind, type Picks } from '../data/type-fields.ts';

export interface TypeBarOpts {
  /** 日历页选中的那天；别的页为 null */
  day: DateStr | null;
  /** 送 ai-parse；不给 = 还没接上，当没开 AI */
  callAi?: CallAi | undefined;
  /** 测试用：写入口 */
  writer?: Writer | undefined;
  /** 测试用：在线与否 */
  online?: (() => boolean) | undefined;
  /** 判成查找、总结、取消改期完成，已经交给结果层：调用方收起打字条；find 是回车查找，asked 是判意图判出来的 */
  onAsked?: ((reason: HandOff) => void) | undefined;
  /** 这一句（连同确认行选完的）都存好了：调用方自动收起 */
  onSaved?: (() => void) | undefined;
  /** 提示条里“修改”某一条（交给外挂的提示条用，见 data/type-batch.ts） */
  onEdit?: ((table: string, id: string) => void) | undefined;
}

export type TypeBarError = 'not_saved' | 'nothing' | null;

/** 交给结果层的两种由来（onAsked 的参数，也是打字条 settle 的 reason） */
export type HandOff = 'find' | 'asked' | 'ai';

export type TypeBarState = ReturnType<typeof useTypeBar>;

export function useTypeBar(o: TypeBarOpts) {
  const [text, setTextRaw] = useState('');
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [error, setError] = useState<TypeBarError>(null);
  const [partSaved, setPartSaved] = useState(false);
  const [asRecord, setAsRecord] = useState(false);
  /** 手点过的签（见文件头）；made：这次在分类签里新建的名字（还没存进库，列表里先放着） */
  const [picks, setPicks] = useState<Picks>({});
  const [made, setMade] = useState<string[]>([]);
  const busy = useRef(false);
  const typed = useRef(false);
  /** 正在整理的那一次的取消（卸载时中止） */
  const inflight = useRef<AbortController | null>(null);
  useEffect(() => () => inflight.current?.abort(), []);
  // 没传 callAi 时用真的 ai-parse（data/ai-parse-api.ts）；测试传桩
  const { day, callAi = callAiParse, writer, online = onlineNow } = o;
  const { ctx, aiOn: aiOnNow, chips } = useCaptureCtx(day);
  const go = useCallback((e: CaptureEvent) => setStatus((s) => captureStep(s, e)), []);
  // 存、确认行、撤销、合并都在 data/saved-batch（和录音同一套）；这一批在模块里整页一份（data/type-batch.ts，提示条外挂，打字条收起直接卸掉）。
  // 每次渲染把自己的收尾（flow）、日子、写入口、“修改”交过去（拿到的总是最新的），卸掉时摘掉 flow
  const saved = typeBatch;
  // 回调各取一个出来进依赖：o 每次渲染都是新对象，依赖整个 o 等于没 memo
  const { onEdit, onSaved, onAsked } = o;
  useEffect(() =>
    bindTypeBatch({
      day, writer, onEdit,
      flow: {
        go,
        // 这一批都存好了（草稿 type-batch 已清）：清输入条，交给调用方自动收起
        done(p) {
          typed.current = false;
          setTextRaw('');
          setPicks({});
          go({ type: 'done', status: p.status });
          onSaved?.();
        },
        // 没写进去：提示（switching 时页面马上要走，不提示），原话留着
        fail(out) {
          if (out !== 'switching') setError(out === 'nothing' ? 'nothing' : 'not_saved');
          go({ type: 'reset' });
        },
        error: (out) => setError(out === 'switching' ? null : 'not_saved'),
      },
    }));
  // 停在确认行时卸掉（收起、换页）：这一批不画了（已经存了的几条照旧在库里）
  useEffect(() => () => {
    if (saved.box.getState().ask.length > 0) saved.fresh();
  }, [saved]);
  const { asking } = useSavedBatch(saved.box, status === 'confirming');
  // 整理中、停在确认行时占住升级中心 busy：更新横幅等这一句收尾再出，不重新载入丢掉等着选的那一条（和录音 voice-session.ts 的 busyNow 一致）
  //   不用 kit 的 useHoldBusy 加开关：它在首屏里，加参数首屏多 16 B（额度只剩 8 B）；打字条不在首屏
  const holding = status === 'organizing' || status === 'confirming';
  useEffect(() => (holding ? getBoot()?.upgrade.holdBusy('editing') : undefined), [holding]);

  const setText = useCallback((v: string) => {
    typed.current = true;
    setTextRaw(v);
    setError(null);
    setPartSaved(false);
    setAsRecord(false);
  }, []);

  /** 把草稿填回来（挂上时由界面调；用户这次已经打过字就不覆盖）；返回取消（卸掉了，晚到的不填） */
  const refill = useCallback((): (() => void) => {
    let live = true;
    void readTypeDraft().then((d) => {
      if (live && d && !typed.current) setTextRaw(d.text);
    });
    return () => {
      live = false;
    };
  }, []);
  /** 这次打过字没有（收起时留不留草稿看它） */
  const dirty = useCallback((): boolean => typed.current, []);

  // 签：本机规则不带日历页的默认日子（“认出来的”只算话里说了的；默认日子由界面另画、记下时照旧补）
  const local = useMemo(() => (text.trim() === '' ? [] : planLocal(text, { ...ctx(), day: null }).result.items), [text, ctx]);
  const remindWord = remindAsked(text);
  const fields = useMemo(() => fieldsOf(local, picks, { fallback: day !== null ? 'event' : 'todo', remindWord }), [local, picks, day, remindWord]);
  // 分类签列的：同待办页项目筛选条（useCaptureCtx 的 chips）+ 这次“＋”新建的（库里没有的分类不显示，和待办页同一份）
  const projects = useMemo(() => [...new Set([...chips, ...made])], [chips, made]);
  /** 点签（盖过识别结果）；只记哪几格，不记值（分类名是用户写的字） */
  const pick = useCallback((p: Picks): void => {
    rlog(`typebar pick k=${Object.keys(p).join(',')}`);
    setPicks((was) => ({ ...was, ...p }));
  }, []);
  /** 分类签末尾“＋”新建：放进这次的列表并选中（写进 project，存了以后列表自然从库里数出来） */
  const addProject = useCallback((name: string): void => {
    setMade((was) => (was.includes(name) ? was : [...was, name]));
    pick({ project: name });
  }, [pick]);
  const today = todayOf(clock.now(), currentTz());
  /** 看起来是要查找时的查询词（见文件头）；不是查找、或点了“改成记下”为 null */
  //   本机规则看出的意图用 data/type-flow.ts 的 localHint（和记下流程 planTyped 同一份 localIntent + askOfLocal + 有把握）
  const findAsk = useMemo(() => {
    if (asRecord || text.trim() === '') return null;
    const { hint, sure } = localHint(text, { now: clock.now(), tz: currentTz() });
    return sure && hint && 'query' in hint && hint.intent === 'search' && hint.query.range === null && hint.query.text.trim() !== '' ? hint : null;
  }, [text, asRecord]);
  const find = findAsk && 'query' in findAsk ? findAsk.query.text.trim() : null;
  /** 交给结果层（查找、判意图共用）：原话进草稿（toAssist），清掉这句字、不再算打过字，调用方按由来收起 */
  const handOff = useCallback((ask: AssistAsk, aiUsed: 0 | 1, reason: HandOff): void => {
    toAssist({ ask, raw: text, aiUsed, from: 'plus', day: ctx().day });
    typed.current = false;
    setTextRaw('');
    setPicks({});
    onAsked?.(reason);
  }, [text, ctx, onAsked]);
  /** 回车或点“查找”：和判意图的那一路同一个出口 handOff（查找面板页脚有“改成记下”“总结一下”） */
  const openFind = useCallback((): void => {
    if (!findAsk) return;
    // 只记查询词的字数
    rlog(`typebar find len=${[...findAsk.query.text.trim()].length}`);
    handOff(findAsk, 0, 'find');
  }, [findAsk, handOff]);
  const keepRecord = useCallback(() => setAsRecord(true), []);
  /** 点“问 AI”：交给 AI 助手抽屉，清字、收起（同 handOff，出口换成 toChat）；正在识别时不收 */
  const askAi = useCallback((): void => {
    if (text.trim() === '' || status === 'organizing') return;
    rlog(`typebar ask len=${[...text.trim()].length}`);
    toChat({ raw: text, day: ctx().day });
    typed.current = false;
    setTextRaw('');
    setPicks({});
    onAsked?.('ai');
  }, [text, status, ctx, onAsked]);

  const submit = useCallback(async () => {
    rlog(`typebar submit len=${text.length} trim=${text.trim().length} busy=${busy.current} status=${status}`);
    if (busy.current || text.trim() === '') {
      rlog(`typebar submit skipped ${busy.current ? 'busy' : 'empty'}`);
      return;
    }
    busy.current = true;
    setError(null);
    const ac = new AbortController();
    inflight.current = ac;
    // 耗时进日志：分清按记下以后慢在等 AI、超时、限流还是写库
    const t0 = performance.now();
    const ms = (): number => Math.round(performance.now() - t0);
    try {
      const c = ctx();
      // 上一句停在结局（提示条还开着）：先收掉结局再开始整理，不然 organize 被吞、AI 回来的确认行丢
      go({ type: 'cleared' });
      go({ type: 'organize' });
      // “正在识别…”出现；消失在 finally 里记 off 和一共多久
      rlog('typebar recog on');
      // 同意版本明确过期（告知页关口问到 first / updated、还没做完）：不发 ai-parse，用本机规则（见 useCaptureCtx）
      const aiOn = aiOnNow();
      const { plan: raw, quotaOut } = await planText(text, c, { online, aiOn, call: callAi, signal: ac.signal });
      // 手选优先：本机或 AI 的结果都只改没点过的格子（data/type-fields.ts）
      const p = { ...raw, items: applyPicks(raw.items, picks, text, remindAsked(text)) };
      if (ac.signal.aborted) {
        rlog('typebar submit dropped unmounted');
        return;
      }
      rlog(`typebar planned items=${p.items.length} ai=${aiOn} quotaOut=${quotaOut} origin=${p.origin} status=${p.status} reason=${p.aiReason ?? '-'} ms=${ms()}`);
      if (p.ask) {
        go({ type: 'reset' });
        handOff(p.ask.ask, p.ask.aiUsed, 'asked');
        return;
      }
      saved.land(await saved.save(p, text), p);
      // 存的时候打字条已经卸了（整理中收起、换页；卸掉时 inflight 已中止）：这一批不出提示条、确认行不问
      // （已经存了的几条照旧在库里、草稿照样清，见 data/type-batch.ts）
      if (ac.signal.aborted) saved.fresh();
    } catch (err) {
      // 只记错误名：message 里可能带着标题、原话片段（不记用户输入的文字）
      rlog(`typebar submit threw ${(err as Error | undefined)?.name ?? typeof err}`);
      throw err;
    } finally {
      busy.current = false;
      if (inflight.current === ac) inflight.current = null;
      rlog(`typebar recog off ms=${ms()}`);
    }
  }, [text, status, ctx, callAi, aiOnNow, online, saved, go, handOff, picks]);

  // 确认行没选就关掉：原话去掉已经存了的几条、只留等确认那条的原文，填回输入条（去不干净时原话整句留着，partSaved 为 true：输入条上方提示，一改字就收起）
  const dismissConfirm = useCallback(() => {
    const { batch, ask } = saved.dismiss();
    if (batch && batch.entries.length > 0) {
      const kept = keepAsked(batch.raw, batch.entries.map((e) => e.item), ask, (t) => planLocal(t, ctx()).result.items);
      setTextRaw(kept ?? batch.raw);
      setPartSaved(kept === null);
    }
  }, [saved, ctx]);

  // 收起：这次打过字才留草稿（写前先置 false，同一句不写两遍）；展开编辑：字带去新建页了，草稿清掉（下次打开不再填回）
  const stash = useCallback(async (): Promise<void> => {
    if (!typed.current) return;
    typed.current = false;
    await writeTypeDraft({ text, day }, clock.now());
  }, [text, day]);

  const dropDraft = useCallback(() => void clearTypeDraft(), []);
  const { choose } = saved;
  return { text, setText, status, fields, picks, pick, projects, addProject, today, find, openFind, keepRecord, askAi, asking, error, submit, choose, dismissConfirm, partSaved, stash, dropDraft, refill, dirty };
}

/** 外挂的提示条（ui/TypeNotice）用：模块里这一批的提示（确认行在问时不出）、动作、“修改”（最近一次挂上的打字条交来的）。
 *  和 App 换页卸掉打字条同样的时机关：
 *  • 换页（路由名变了）：等新页面的 <main> 显示出来（最多 FADE_WAIT_MS），和 App 收打字条同一个 whenMainShown
 *  • 换到没有“＋”的页（提示条跟着 TypeBarPreload 卸掉）：当场关 */
export function useTypeNotice(route: string) {
  const asking = useStore(typeBatch.box, (st) => st.ask.length > 0);
  const { notice } = useSavedBatch(typeBatch.box, asking);
  const was = useRef(route);
  useEffect(() => {
    if (was.current === route) return undefined;
    was.current = route;
    return whenMainShown(dropTypeNotice, FADE_WAIT_MS);
  }, [route]);
  useEffect(() => dropTypeNotice, []);
  return { notice, acts: typeBatch, onEdit: typeOnEdit() };
}

/** 打字条那一批的提示条出着没有（TypeBarPreload 用：出着时“＋”上方的小气泡不画，同打字条开着时） */
export const useTypeNoticeOn = (): boolean => useStore(typeBatch.box, typeNoticeOn);
