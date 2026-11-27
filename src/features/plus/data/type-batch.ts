// “＋”打字条记下的这一批放在模块里，整页一份（录音那一份由控制器 voice-session.ts 持有，同一个思路）
// • 打字条一收起就直接卸掉；“已记下 · 撤销”提示条由 ui/TypeNotice.tsx（TypeBarPreload 里一直挂着）照这一份画，不跟着打字条卸，
//   照常满 8 秒、能撤销、能合并；再点“＋”新挂的打字条接着用同一份（提示条抬到打字条上方，见 TypeNotice）
// • 打字条挂上时 bind 自己的收尾（flow：状态机、清输入条、失败提示、记下后自动收起）、日历页选中的那天、提示条上的“修改”、测试的写入口；
//   卸掉时只摘掉 flow（之后的 go、fail 不再调），日子、写入口、“修改”留着给提示条上的合并、撤销用
// • 这一批都存好了（done）先清草稿再交给打字条：存的时候打字条已经卸了（整理中收起、换页）也照样清，下次打开不把存过的那句填回来
//   （那时这一批由 hooks/useTypeBar 的 submit 收掉、不出提示条）
// 纯 TS：不准 import React
import type { DateStr } from '../../../../shared/core/date.ts';
import { getBoot } from '../../../core/boot.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { write } from '../../../core/write.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { Writer } from './capture-save.ts';
import { createBatchBox, createSavedBatch, replaceHeld, type BatchFlow, type BatchMark, type BatchState } from './saved-batch.ts';
import { clearTypeDraft } from './type-draft.ts';
import { planText, type PlanTextOpts, type TypeCtx, type TypePlan } from './type-flow.ts';

export interface TypeBind {
  day: DateStr | null;
  /** 测试用：写入口（不给用正式的 core/write.ts） */
  writer: Writer | undefined;
  /** 提示条里“修改”某一条（App 开编辑页；不给就不显示“修改”） */
  onEdit: ((table: string, id: string) => void) | undefined;
  /** 挂着的打字条自己的收尾；没挂着为 null */
  flow: BatchFlow | null;
}

let bound: TypeBind = { day: null, writer: undefined, onEdit: undefined, flow: null };
const writer = (): Writer => bound.writer ?? write;

export const typeBatch = createSavedBatch({
  box: createBatchBox(),
  tag: 'typebar',
  writer: { insert: (...a) => writer().insert(...a), patch: (...a) => writer().patch(...a) },
  env: () => ({ now: clock.now(), tz: currentTz(), day: bound.day }),
  flow: {
    go: (e) => bound.flow?.go(e),
    done(p) {
      void clearTypeDraft();
      bound.flow?.done(p);
    },
    fail: (out) => bound.flow?.fail(out),
    error: (out) => bound.flow?.error(out),
  },
});

/** 打字条挂上、重画时调（拿到的总是最新的）；返回卸掉时调的（只摘掉这一次交来的 flow） */
export function bindTypeBatch(b: TypeBind): () => void {
  bound = b;
  return () => {
    if (bound.flow === b.flow) bound = { ...bound, flow: null };
  };
}

/**
 * 打字条“先存、AI 后台再换”的后台那一半（负责人 11-27：“直接记下 ai 再识别”，R-496；先存那一半在 hooks/useTypeBar 的 submit，
 * 哪些句子走这条由 type-flow 的 planTyped 定：交回的 plan 带 later）：同一句不带 later 再交 planText（这次调 ai-parse，花 1 次），手选的签照样盖上（finish）；
 * AI 拆出了条目（origin ai）就经 saved-batch 的 replaceHeld 换掉先存的那一批（m）——换不换的规则和按住说话那一路同一份（replace：撤掉删掉、改过勾完成、
 * 编辑页开着、要先问日子、一样，都不换；提示条还开着的写“AI 已整理”）；日子按说这句那一刻的（ctx 的时区、选中的那天），不按换的时候打字条绑着的。
 * 不随打字条收起、切页取消（已经存下了）。AI 没成、次数用完、AI 判成别的意图（走到这里的句子本机没有意图迹象，AI 判的不算数）：先存的留着，只记日志——
 * 以前等 AI 时这种句子提示条会多一行“改成搜索”，先存以后提示条早就出了，不再补（有意去掉）。
 * 不像录音那样设“回来太晚就不换”（voice-pending 的 LIVE_LATE_MS 20 秒）：ai-parse 一次最多 AI_PARSE_TIMEOUT_MS（6 秒），只在网络错误时重试 1 次，
 * 加上锁被占着的 1 秒，最晚 13 秒左右，用不上
 * 日志（不记字）：typebar tidy out=replaced|same|skip_*|not_saved|rule_<状态>|error_<名> reason=<AI 没成的原因，没有为 -> ms=（交 AI 到换完）
 */
export async function tidyTyped(m: BatchMark, text: string, ctx: TypeCtx, o: PlanTextOpts, finish: (p: TypePlan) => TypePlan): Promise<string> {
  const t0 = performance.now();
  let out: string;
  let reason = '-';
  let proj = '-';
  try {
    const p = finish((await planText(text, ctx, { ...o, later: false })).plan);
    reason = p.aiReason ?? '-';
    // R-497：AI 给的项目和先存的有几条不同（只记条数，不记项目名）；ex= 这一句带了几条以前怎么分的例子
    if (p.origin === 'ai') {
      const held = m.batch.entries;
      proj = `${p.items.filter((it, i) => (it.project ?? null) !== (held[i]?.item.project ?? null)).length}`;
    }
    out = p.origin !== 'ai'
      ? `rule_${p.status}`
      : await replaceHeld(typeBatch, m, p, text, () => getBoot()?.upgrade.holdBusy('editing'), 'typebar', { tz: ctx.tz, day: ctx.day });
  } catch (e) {
    out = `error_${e instanceof Error ? e.name : 'unknown'}`;
  }
  rlog(`typebar tidy out=${out} reason=${reason} proj=${proj} ex=${ctx.examples?.length ?? 0} ms=${Math.round(performance.now() - t0)}`);
  return out;
}

/** 提示条里“修改”用的（最近一次挂上的打字条交来的） */
export const typeOnEdit = (): TypeBind['onEdit'] => bound.onEdit;

/** 提示条现在出着没有（noticeOf 不为 null、确认行没在问；同 hooks/useSavedBatch 的判断） */
export const typeNoticeOn = (s: BatchState): boolean => s.ask.length === 0 && (s.batch?.entries.length ?? 0) > 0;

/** 这一批还在就关掉提示条（换页、提示条卸掉时） */
export function dropTypeNotice(): void {
  if (typeBatch.box.getState().batch) typeBatch.closeNotice();
}
