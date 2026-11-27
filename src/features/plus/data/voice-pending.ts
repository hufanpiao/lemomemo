// 按住“＋”松手以后的“先存、后台再换”（只此一套）：松手马上存，不等 AI；一个字没出先记一条“整理中”；切页照样整理
// • saveNow：voice-rec.ts 松手那一刻拼好的 plan 当场存（savePlan，这一批 saved-batch 的 save，提示条照常“已记下 · 撤销”），面板马上关，不等 AI。
//   出过字的存本机规则拆出的（拆不出整句存成今天的一条待办）；一个字没出的存占位“语音记录 · 整理中”——占位就是没有字时的特例。
//   写库失败回 keep：voice-rec.ts 把录音留着、提示条给“重试”（前台上传这段录音）
// • tidyLater：这段录音在后台交 ai-voice 一次（一句话只扣这一次），结果经 voice-flow 的 finishVoice 映射成动作；拆出了条目就经
//   saved-batch 的 replace 换掉先存的（先存新、再撤旧，提示条还开着的写“AI 已整理”）。不随切页取消（已经存下了）
//   - 出过字的（own = false）：换不了（一样、用户动过、AI 失败、松手后 LIVE_LATE_MS 还没回来）只记日志，留着先存的，不让人重说
//   - 占位（own = true）：录音同时放进本机库的 drafts 仓（kind 'voice-pending'，id 跟着占位那一条），iPhone 主屏幕版被关掉也还在；
//     整理期间整段占住升级中心的 busy（被自动重新载入打断会丢结果、重试又多扣一次）；
//     AI 说没听到说话撤掉占位；判成查找、总结的撤掉占位、交给结果层；有转写但拆不出条目的整句换进占位；
//     失败（超时、断网、AI 没回应、今天用完、没同意）：占位改名“语音记录 · 没整理成”、录音留着；
//     AI 成了但换不了（要先问的过去月日 skip_confirm、编辑页开着或动过 skip_edited、锁占着 skip_busy、正在录下一句 skip_ask_busy、写不进）：
//     这次的结果跟着占位留下（内存一份、drafts 一份），点重试直接拿它收尾，不再调 AI；skip_busy 先等 BUSY_RETRY_MS 再试一次，不算失败
// • 点开这一条（待办编辑页顶上一行，ui/VoicePending.tsx）“重试”：走前台（voice-rec.ts 的 retryPending），收下了撤掉占位；
//   出了确认行等选完或关掉再定：存上了条目撤掉占位，一条没存留着
// • 用户动过没有只看 saved-batch 的 look（和 replace 同一份）：撤掉、删掉的不再留录音；改过、勾完成、编辑页开着的不改名、不撤，录音照样留着给重试
// • app 被关掉时还在等 AI 的：下次挂上（sweep，本机库开了才算扫过）一律改成“没整理成”，录音还在就能点重试；
//   录音留 PENDING_KEEP_MS（7 天），过了只删录音、占位留着当普通待办
// • 运行日志（不记说的内容）：voice saved path=text|whole|pending out= n= bytes= ms=（松手到存好）；
//   voice tidy path=text|pending out=replaced|same|dropped|asked|skip_*|failed_* ms=（交 AI 到出结果）total_ms=（松手起）；
//   换成了的前面多一行 voice tidy days local=+2,+0 ai=+4,+0（先存的、AI 的每条日子离今天差几天，没日子 n；只记差几天）；
//   voice pending retry bytes= [res=1]；voice pending settle out=；voice pending sweep n= stale= expired=
// 纯 TS：不准 import React
import { createStore } from 'zustand/vanilla';
import { diffDays, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { getBoot } from '../../../core/boot.ts';
import type { Cache } from '../../../core/cache.ts';
import { write } from '../../../core/write.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { undoRefs } from './capture-save.ts';
import type { BatchMark, MarkLike, ReplaceOut } from './saved-batch.ts';
import { baseReqCtx, type TypeCtx, type TypePlan } from './type-flow.ts';
import { finishVoice, sendVoice, toUpload, type VoiceClip, type VoiceResult, type VoiceSink } from './voice-flow.ts';
import type { Attempt, VoiceCore } from './voice-session.ts';

/** 录音在本机最多留这么久（过了只删录音，占位那一条留着） */
export const PENDING_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const PENDING_KIND = 'voice-pending';
/** 出过字的：松手以后 AI 过了这么久才回来就不换了（先存的已经看了很久，再换反倒让人糊涂） */
export const LIVE_LATE_MS = 20_000;
/** 换的那一下锁被占着（提示条上正在撤销、合并）：等这么久再试一次 */
export const BUSY_RETRY_MS = 1000;
const draftId = (id: string): string => `${PENDING_KIND}:${id}`;

/** 占位这一条现在怎样（编辑页那一行画它）：tidying 后台在等 AI；failed 没整理成、可以重试；retrying 点了重试、正在收尾 */
export type PendingState = 'tidying' | 'failed' | 'retrying';
export const createPendingBox = () => createStore<Record<string, PendingState>>(() => ({}));
export type PendingBox = ReturnType<typeof createPendingBox>;

/** 本机库存进 drafts 的：录音、状态、占位那一条当时的样子（seen，app 重开以后判动没动过）、AI 回来了但没换成的结果 */
interface PendingDraft {
  blob: Blob;
  mime: string;
  state: 'tidying' | 'failed';
  seen?: string | null;
  res?: VoiceResult;
}

export type DraftStore = Pick<Cache, 'getDraft' | 'putDraft' | 'deleteDraft' | 'allDrafts'>;

/** 占位的两种标题（按界面语言，hooks/pending-text.ts 查好经控制器的 bind 交进来；数据层不引词典） */
export interface PendText {
  title: string;
  failed: string;
}

/** 占位留着的：判动没动过的记号、录音、AI 已经回来但没换成的结果 */
export interface Held {
  m: MarkLike;
  clip: VoiceClip;
  res: VoiceResult | null;
}

/** 松手那一刻存成什么（日志 path=）：text 本机规则拆出的；whole 出了字但拆不出，整句一条待办；pending 一个字没出的占位 */
export type SavePath = 'text' | 'whole' | 'pending';

/** drafts 里旧格式（没有 seen）的：拼回来的记号和库里永远对不上，按动过算（不改名、不撤，录音照样能重试） */
const NO_SEEN = '?';

const isDraft = (v: unknown): v is PendingDraft =>
  typeof v === 'object' && v !== null && (v as Record<string, unknown>)['blob'] instanceof Blob && typeof (v as Record<string, unknown>)['mime'] === 'string';
const resOf = (v: unknown): VoiceResult | null =>
  typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['kind'] === 'string' ? (v as VoiceResult) : null;
const failOut = (res: VoiceResult): string => `failed_${res.kind === 'failed' ? res.reason : res.kind}`;

/** 每条的日子（日程看 date、待办看 due）离今天差几天，逗号隔开（+2,+0,-1；没日子的写 n）：只记差几天，不记日期原值、不记说的字 */
export function daysOff(items: readonly AiItem[], today: DateStr): string {
  return items.map((it) => {
    const day = it.kind === 'event' ? it.date : it.kind === 'todo' ? it.due : null;
    if (day === null) return 'n';
    const n = diffDays(today, day);
    return n >= 0 ? `+${n}` : String(n);
  }).join(',');
}

/** store：测试传桩（不给用控制器的 drafts，再不给用本机库；库没开时只留在内存） */
export function createPending(c: VoiceCore, store?: DraftStore | null) {
  const box = createPendingBox();
  /** 这一次运行里留着的（库没开、写不进也能重试） */
  const held = new Map<string, Held>();
  /** 这一次运行里还在等 AI 的（sweep 不把它们改成没整理成） */
  const running = new Set<string>();
  let swept = false;
  const cache = (): DraftStore | null => {
    const s = store !== undefined ? store : c.drafts;
    return s !== undefined ? s : (getBoot()?.cache ?? null);
  };
  const w = () => c.writer ?? write;
  const set = (id: string, s: PendingState | null): void => {
    const next = { ...box.getState() };
    if (s === null) delete next[id];
    else next[id] = s;
    box.setState(next, true);
  };
  const putDraft = async (id: string, h: Held, state: PendingDraft['state']): Promise<void> => {
    const data: PendingDraft = { blob: h.clip.blob, mime: h.clip.mime, state, seen: h.m.seen[0] ?? null, ...(h.res ? { res: h.res } : {}) };
    try {
      await cache()?.putDraft({ id: draftId(id), kind: PENDING_KIND, data, updated_at: clock.now() });
    } catch {
      // 库没开、正在关：只留在内存（这次运行里照样能重试）
    }
  };
  /** 不用再留了：录音删掉、编辑页那一行收起 */
  const forget = async (id: string): Promise<void> => {
    held.delete(id);
    running.delete(id);
    set(id, null);
    try {
      await cache()?.deleteDraft(draftId(id));
    } catch {
      // 删不掉：过 PENDING_KEEP_MS 由 sweep 删
    }
  };
  /** 从本机库拼回来的记号（app 重开以后）：只够判动没动过、撤掉，不比改动号 */
  const markOf = (id: string, seen: string | null | undefined): MarkLike => ({
    batch: { batchId: null, entries: [{ ref: { table: 'todos', id } }] },
    rev: -1,
    seen: [seen === undefined ? NO_SEEN : seen],
  });
  /** 没整理成：占位改名（用户没动过才改）、录音和这次的结果（有就带上）留着、编辑页那一行给“重试” */
  const fail = async (id: string, res: VoiceResult | null = null): Promise<void> => {
    running.delete(id);
    set(id, 'failed');
    const h = held.get(id);
    if (!h) return;
    if (res) h.res = res;
    if (c.batch.look(h.m) === 'ok') {
      await w().patch('todos', id, { title: c.d().pend.failed, updated_at: clock.now() });
      // 自己改的标题不算用户动过
      h.m = c.batch.remark(h.m);
    }
    await putDraft(id, h, 'failed');
  };
  /** 撤掉占位（用户没动过才撤）、录音不留 */
  const drop = async (id: string): Promise<void> => {
    const h = held.get(id);
    if (h && c.batch.look(h.m) === 'ok') await undoRefs([{ table: 'todos', id }], clock.now(), c.writer);
    // 提示条还在画这一批（只有这一条占位）：收起
    if (c.batch.box.getState().batch?.entries.some((e) => e.ref.id === id)) c.batch.closeNotice();
    await forget(id);
  };

  /** 换掉先存的（saved-batch 的 replace）：换的那一下占住升级中心的 busy；锁被占着（skip_busy）等一会再试一次；
   *  换成了记一行每条日子离今天差几天（daysOff，日志看得出换成了哪天） */
  const swapIn = async (m: BatchMark, plan: TypePlan, raw: string, today: DateStr): Promise<ReplaceOut> => {
    const once = async (): Promise<ReplaceOut> => {
      const free = getBoot()?.upgrade.holdBusy('recording');
      try {
        return await c.batch.replace(m, plan, raw);
      } finally {
        free?.();
      }
    };
    let out = await once();
    if (out === 'skip_busy') {
      rlog('voice tidy busy_retry');
      await new Promise<void>((ok) => setTimeout(ok, BUSY_RETRY_MS));
      out = await once();
    }
    if (out === 'replaced') rlog(`voice tidy days local=${daysOff(m.batch.entries.map((e) => e.item), today)} ai=${daysOff(plan.items, today)}`);
    return out;
  };

  /** 出过字先存的那一批：换不了只记日志 */
  const textSink = (m: BatchMark, t0: number, res: VoiceResult, today: DateStr): VoiceSink<string> => ({
    save: async (plan, raw) => (performance.now() - t0 > LIVE_LATE_MS ? 'skip_late' : swapIn(m, plan, raw, today)),
    ask: async () => 'skip_ask',
    none: async () => 'skip_none',
    miss: async () => failOut(res),
  });
  /** 占位：换掉、撤掉、改成没整理成；AI 成了但换不了的结果跟着占位留下（见文件头） */
  const pendSink = (id: string, m: BatchMark, res: VoiceResult, today: DateStr): VoiceSink<string> => ({
    async save(plan, raw) {
      const out = await swapIn(m, plan, raw, today);
      if (out === 'replaced' || out === 'same' || out === 'skip_gone') await forget(id);
      else await fail(id, res);
      return out;
    },
    async ask(ask, raw) {
      // 正在录下一句：不打断，结果留着（点重试再交结果层）
      if (c.current() !== null) {
        await fail(id, res);
        return 'skip_ask_busy';
      }
      await drop(id);
      rlog(`voice ask intent=${ask.intent} ai=1 len=${[...raw].length}`);
      c.d().onAsk?.(ask, raw, 1, 'voice');
      return 'asked';
    },
    async none() {
      await drop(id);
      return 'dropped';
    },
    async miss() {
      await fail(id);
      return failOut(res);
    },
  });

  /** 这一条留着的（点了重试、编辑页读）：这次运行里的，或本机库里的；过期、没有为 null */
  const heldOf = async (id: string): Promise<Held | null> => {
    const mem = held.get(id);
    if (mem) return mem;
    try {
      const d = await cache()?.getDraft(draftId(id));
      if (!d || !isDraft(d.data)) return null;
      if (clock.now() - d.updated_at > PENDING_KEEP_MS) {
        await forget(id);
        return null;
      }
      const h: Held = { m: markOf(id, d.data.seen), clip: { blob: d.data.blob, mime: d.data.mime }, res: resOf(d.data.res) };
      held.set(id, h);
      return h;
    } catch {
      return null;
    }
  };

  const settled = async (id: string, out: 'saved' | 'dropped' | 'failed', res: VoiceResult | null = null): Promise<void> => {
    rlog(`voice pending settle out=${out}`);
    if (out === 'failed') return fail(id, res);
    await drop(id);
  };

  return {
    box,
    /** 松手那一刻存（t0 = 松手那一刻，bytes 这一次录音的字节数）：存成了交回这一批的记号（后台拿它换）；写库失败 keep（留录音给重试）；
     *  别的（交给了结果层、出了确认行、这一次已作废）done */
    async saveNow(a: Attempt, plan: TypePlan, raw: string, t0: number, path: SavePath, bytes: number): Promise<BatchMark | 'keep' | 'done'> {
      const out = await c.savePlan(a, plan, raw);
      rlog(`voice saved path=${path} out=${out} n=${plan.items.length} bytes=${bytes} ms=${Math.round(performance.now() - t0)}`);
      const m = out === 'ok' ? c.batch.mark() : null;
      if (m) return m;
      return out === 'not_saved' ? 'keep' : 'done';
    },
    /** 后台：录音交 ai-voice，回来换掉先存的（见文件头）。own：先存的是占位（只有一条） */
    async tidyLater(m: BatchMark, clip: VoiceClip, ctx: TypeCtx, t0: number, own: boolean): Promise<void> {
      const id = own ? (m.batch.entries[0]?.ref.id ?? null) : null;
      if (id !== null) {
        const h: Held = { m, clip, res: null };
        held.set(id, h);
        running.add(id);
        set(id, 'tidying');
        await putDraft(id, h, 'tidying');
      }
      const free = id !== null ? getBoot()?.upgrade.holdBusy('recording') : undefined;
      const t1 = performance.now();
      let out: string;
      try {
        const d = c.d();
        const res = await sendVoice(await toUpload(clip), baseReqCtx(ctx), d.callVoice, { online: d.online });
        c.account(res);
        const today = todayOf(ctx.now, ctx.tz);
        out = await finishVoice(res, ctx, d.online(), id !== null ? pendSink(id, m, res, today) : textSink(m, t0, res, today));
      } catch (e) {
        out = `error_${e instanceof Error ? e.name : 'unknown'}`;
        if (id !== null) await fail(id).catch(() => undefined);
      } finally {
        free?.();
      }
      const now = performance.now();
      rlog(`voice tidy path=${id !== null ? 'pending' : 'text'} out=${out} ms=${Math.round(now - t1)} total_ms=${Math.round(now - t0)}`);
    },
    heldOf,
    retrying: (id: string): void => set(id, 'retrying'),
    /** 前台重试回来（voice-rec.ts 的 handle）：saved 收下了 / dropped 没有内容——都撤掉占位、录音不留；failed 照旧留着（res：这次的结果，下次直接用） */
    settled,
    /** 前台重试出了确认行：等选完或关掉——这一批存上了条目就撤掉占位，一条都没存就留着、结果留给下次 */
    confirming(id: string, res: VoiceResult): void {
      const off = c.subscribe(() => {
        if (c.view().status === 'confirming') return;
        off();
        const n = c.batch.box.getState().batch?.entries.length ?? 0;
        void (n > 0 ? settled(id, 'saved') : settled(id, 'failed', res));
      });
    },
    /** 编辑页那一行要画的：这次运行里没碰过的，看本机库里有没有留着的录音（有 = 没整理成，能重试） */
    async load(id: string): Promise<void> {
      if (box.getState()[id] !== undefined) return;
      if ((await heldOf(id)) !== null && box.getState()[id] === undefined) set(id, 'failed');
    },
    /** 挂上时（每次运行一次，本机库开了才算）：上次 app 被关掉时还在等 AI 的改成没整理成；过期的、占位已经删掉撤掉的录音删掉 */
    async sweep(): Promise<void> {
      if (swept) return;
      const db = cache();
      // 启动还没好、库还没开：这次不算扫过，下次挂上再扫
      if (!db) return;
      swept = true;
      let all: { id: string; kind: string; data: unknown; updated_at: number }[];
      try {
        all = (await db.allDrafts()).filter((x) => x.kind === PENDING_KIND);
      } catch {
        swept = false;
        return;
      }
      let stale = 0;
      let expired = 0;
      for (const x of all) {
        const id = x.id.slice(PENDING_KIND.length + 1);
        if (running.has(id) || !isDraft(x.data)) continue;
        const m = markOf(id, x.data.seen);
        if (clock.now() - x.updated_at > PENDING_KEEP_MS || c.batch.look(m) === 'gone') {
          expired += 1;
          await forget(id);
          continue;
        }
        if (x.data.state === 'tidying') {
          stale += 1;
          held.set(id, { m, clip: { blob: x.data.blob, mime: x.data.mime }, res: resOf(x.data.res) });
          await fail(id);
        }
      }
      rlog(`voice pending sweep n=${all.length} stale=${stale} expired=${expired}`);
    },
  };
}

export type Pending = ReturnType<typeof createPending>;
