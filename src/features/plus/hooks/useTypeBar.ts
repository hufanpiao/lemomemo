// 打字条的状态和动作（B3 任务单 S2、FA-2；架构 5.1“点一下打字”、5.9；R-166、R-353）
// • 边打边预览“会记成这样”：只跑本机规则（planLocal），不花 AI 次数
// • 回车 / “记下”：planTyped → 没有要问的几条先存；有过去的月日的出确认行（confirming），选了才加进同一批（R-166）；
//   没选就关掉 → 原话留在输入条（已经存了的几条照常在提示条上，能撤）
// • 保存经 useSavedBatch → data/capture-save（captureRow、batch_id、outbox）；没写进去：提示“没保存上”，输入框不清空
// • 下滑 / “收起”：已打的字存草稿（本机库 drafts 仓，按账号分）；下次打开填回来
// • “展开编辑”：把已打的字和日历页选中的那天交给调用方，打开完整新建页（R-353）
// • callAi 默认是真的 ai-parse（data/ai-parse-api.ts，B3 接线）；设置里 ai.enabled 没开时不调，没把握的也直接用本机规则，不出“AI 没回应”
// • 提示条：一条 → “已记下：…”；多条 → “已记下 N 条”，展开逐条改、撤，“拆错了，合并成一条”“全部撤销”
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { callAiParse } from '../data/ai-parse-api.ts';
import { captureStep, type CaptureEvent, type CaptureStatus } from '../data/capture-state.ts';
import type { Writer } from '../data/capture-save.ts';
import { quotaOutToday, rememberQuotaLeft } from '../data/quota.ts';
import { clearTypeDraft, readTypeDraft, writeTypeDraft } from '../data/type-draft.ts';
import { keepAsked, navOnline, planLocal, planTyped, type CallAi, type TypePlan } from '../data/type-flow.ts';
import { useCaptureCtx } from './useCaptureCtx.ts';
import { useSavedBatch, type BatchNotice, type SaveEnv, type SaveOutcome } from './useSavedBatch.ts';

// ui 不能直接 import data（A1），界面要用的类型经这里转出去
export type { CallAi } from '../data/type-flow.ts';
export type { Writer } from '../data/capture-save.ts';
export type { BatchEntry } from './useSavedBatch.ts';

export interface TypeBarOpts {
  /** 日历页选中的那天（R-353）；别的页为 null */
  day: DateStr | null;
  /** 送 ai-parse；不给 = 还没接上，当没开 AI */
  callAi?: CallAi | undefined;
  /** 测试用：写入口 */
  writer?: Writer | undefined;
  /** 测试用：在线与否 */
  online?: (() => boolean) | undefined;
}

export type TypeBarError = 'not_saved' | 'nothing' | null;

export interface TypeBarState {
  text: string;
  setText(v: string): void;
  status: CaptureStatus;
  preview: readonly AiItem[];
  /** 确认行要问的那一条（confirming 时） */
  asking: AiItem | null;
  /** 提示条：主句和附加句，加上这一批每一条（多条时展开逐条改、撤） */
  notice: BatchNotice | null;
  error: TypeBarError;
  submit(): Promise<void>;
  choose(choice: 'past' | 'next'): Promise<void>;
  /** 确认行没选就关掉：原话去掉已经存了的几条、只留等确认那条的原文，填回输入条（去不干净时原话整句留着，partSaved 为 true） */
  dismissConfirm(): void;
  /** 输入条里的原话含着已经记下的几条（去不干净），输入条上方提示；一改字就收起 */
  partSaved: boolean;
  /** 全部撤销 */
  undo(): Promise<void>;
  undoOne(id: string): Promise<void>;
  /** 拆错了，合并成一条 */
  merge(): Promise<void>;
  closeNotice(): void;
  /** 收起：留草稿 */
  stash(): Promise<void>;
  /** 展开编辑：字带去新建页了，草稿清掉（下次打开不再填回） */
  dropDraft(): void;
}

export function useTypeBar(o: TypeBarOpts): TypeBarState {
  const [text, setTextRaw] = useState('');
  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [error, setError] = useState<TypeBarError>(null);
  const [partSaved, setPartSaved] = useState(false);
  const busy = useRef(false);
  const typed = useRef(false);
  // 没传 callAi 时用真的 ai-parse（data/ai-parse-api.ts）；测试传桩
  const { day, callAi = callAiParse, writer, online = navOnline } = o;
  const { ctx, aiOn: aiOnNow } = useCaptureCtx(day);
  const saved = useSavedBatch(writer, status === 'confirming', 'typebar');
  const { batch, setBatch, ask, setAsk, asking, notice } = saved;

  const go = useCallback((e: CaptureEvent) => setStatus((s) => captureStep(s, e)), []);
  const setText = useCallback((v: string) => {
    typed.current = true;
    setTextRaw(v);
    setError(null);
    setPartSaved(false);
  }, []);

  // 打开时把草稿填回来（用户已经开始打字就不覆盖）
  useEffect(() => {
    let live = true;
    void readTypeDraft().then((d) => {
      if (live && d && !typed.current) setTextRaw(d.text);
    });
    return () => {
      live = false;
    };
  }, []);

  const env = useCallback((): SaveEnv => ({ now: clock.now(), tz: currentTz(), day }), [day]);

  const preview = useMemo(() => (text.trim() === '' ? [] : planLocal(text, ctx()).result.items), [text, ctx]);

  /** 没写进去：提示（switching 时页面马上要走，不提示），原话留着 */
  const fail = useCallback((out: SaveOutcome) => {
    if (out !== 'switching') setError(out === 'nothing' ? 'nothing' : 'not_saved');
    go({ type: 'reset' });
  }, [go]);

  /** 这一批都存好了：清输入条和草稿，出提示条 */
  const { settle } = saved;
  const finish = useCallback((p: TypePlan) => {
    settle(p);
    setTextRaw('');
    typed.current = false;
    void clearTypeDraft();
    go({ type: 'done', status: p.status });
  }, [go, settle]);

  const submit = useCallback(async () => {
    rlog(`typebar submit len=${text.length} trim=${text.trim().length} busy=${busy.current} status=${status}`);
    if (busy.current || text.trim() === '') {
      rlog(`typebar submit skipped ${busy.current ? 'busy' : 'empty'}`);
      return;
    }
    busy.current = true;
    setError(null);
    // 耗时进日志（负责人 11-13“今天、日历、待办按记下要等一会才存上”：分清是等 AI、超时、限流还是写库慢）
    const t0 = performance.now();
    const ms = (): number => Math.round(performance.now() - t0);
    try {
      const c = ctx();
      go({ type: 'organize' });
      // 同意版本明确过期（告知页关口问到 first / updated、还没做完）：不发 ai-parse，用本机规则（S1，见 useCaptureCtx）
      const aiOn = aiOnNow();
      const quotaOut = aiOn ? await quotaOutToday(c.now) : false;
      const p = await planTyped(text, c, { online: online(), isOnline: online, aiOn, quotaOut }, callAi);
      if (p.quotaLeft !== null) void rememberQuotaLeft(p.quotaLeft, c.now);
      rlog(`typebar planned items=${p.items.length} ai=${aiOn} quotaOut=${quotaOut} origin=${p.origin} status=${p.status} reason=${p.aiReason ?? '-'} ms=${ms()}`);
      if (p.items.length === 0) {
        fail('nothing');
        return;
      }
      const out = await saved.storeNew({ batchId: null, entries: [], plan: p, raw: text, remind: false }, env());
      if (out === 'ask') go({ type: 'need_confirm' });
      else if (out === 'ok') finish(p);
      else fail(out);
    } catch (err) {
      rlog(`typebar submit threw ${(err as Error | undefined)?.name ?? ''} ${String((err as Error | undefined)?.message ?? err).slice(0, 200)}`);
      throw err;
    } finally {
      busy.current = false;
    }
  }, [text, status, ctx, env, callAi, aiOnNow, online, saved, fail, finish, go]);

  const choose = useCallback(async (choice: 'past' | 'next') => {
    const plan = batch?.plan;
    const out = await saved.choose(choice, env());
    if (out === 'skip' || out === 'more') return;
    if (out !== 'done') {
      setError(out === 'switching' ? null : 'not_saved');
      return;
    }
    go({ type: 'confirmed' });
    if (plan) finish(plan);
  }, [batch, saved, env, go, finish]);

  const dismissConfirm = useCallback(() => {
    if (batch && batch.entries.length > 0) {
      const kept = keepAsked(batch.raw, batch.entries.map((e) => e.item), ask, (t) => planLocal(t, ctx()).result.items);
      setTextRaw(kept ?? batch.raw);
      setPartSaved(kept === null);
    }
    setAsk([]);
    go({ type: 'cancel' });
  }, [batch, ask, setAsk, ctx, go]);

  const closeNotice = useCallback(() => {
    setBatch(null);
    go({ type: 'reset' });
  }, [setBatch, go]);

  const undo = useCallback(async () => {
    await saved.undoAll();
    go({ type: 'reset' });
  }, [saved, go]);

  const { undoOne } = saved;

  const merge = useCallback(async () => {
    const raw = batch?.raw ?? '';
    const out = await saved.merge(env());
    if (out !== 'ok') {
      setTextRaw(raw);
      fail(out);
    }
  }, [batch, saved, env, fail]);

  const stash = useCallback(() => writeTypeDraft({ text, day }, clock.now()), [text, day]);

  const dropDraft = useCallback(() => void clearTypeDraft(), []);
  return { text, setText, status, preview, asking, notice, error, submit, choose, dismissConfirm, partSaved, undo, undoOne, merge, closeNotice, stash, dropDraft };
}
