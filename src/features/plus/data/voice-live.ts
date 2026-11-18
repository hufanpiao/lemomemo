// 识别出了字：先存、AI 后台整理（R-456，部分取代 R-62“松手等 AI 回来才存”）。手机自带识别那一路（voice-speech.ts）松手后调
// • 先按本机规则存（planText 不开 AI 的那一支），面板、提示条当场回到“已记下”；本机一条都拆不出来：当场交 ai-parse 整理再存
// • 存成了在后台整理（tidy）：字交 ai-parse，AI 的结果和先存的不一样就经 saved-batch 的 replace 换掉（先存新、再撤旧，和合并同一套）；
//   一样、用户已经动过、AI 失败、松手后 LIVE_LATE_MS 还没回来，都只记日志，不再让人重说
// • 后台整理期间不占升级中心的 busy（已经存下了，被重新载入打断只丢一次整理），只在换的那一下（几十毫秒）占住，免得换到一半记重了；
//   也不随切页取消（这一次已经存完、代号已经收了）
// • 11-18 起录音和识别不再同时开（两路抢麦，日志第二次起都是 0），录音这一路松手照原来整段上传 ai-voice（voice-rec.ts），不经过这里；
//   原来录音路里“录音器开起来以后再开识别边说边出字”那一套（createLiveRoute）走不到了，整块删掉（11-18 语音整块评审第 7、8、9 条）
// • 运行日志（只记字数、毫秒、原因，不记内容）：voice live saved out= n= ai=0|1 ms=（从松手算）；voice live ai skip why=；
//   voice live ai via=parse out=same|replaced|not_saved|skip_touched|skip_late|skip_*|failed_* ms=
// 纯 TS：不准 import React（A1）
import { getBoot } from '../../../core/boot.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { BatchMark, ReplaceOut } from './saved-batch.ts';
import { planText, type TypeCtx, type TypePlan } from './type-flow.ts';
import type { Attempt, VoiceCore } from './voice-session.ts';

/** 松手以后 AI 过了这么久才回来就不换了（先存的已经看了很久，再换反倒让人糊涂） */
export const LIVE_LATE_MS = 20_000;

/** 后台整理的结果（日志 out=）：saved-batch 的 replace 给的，或者没交给 replace 的原因 */
type TidyOut = ReplaceOut | `skip_${string}` | `failed_${string}`;

/** ai-parse（planText 开 AI）的结果 → 拿来换的；本机有把握没调 AI（和打字一样）、额度用完、离线、没开 AI 的给原因 */
function parsePlan(plan: TypePlan): TypePlan | TidyOut {
  if (plan.ask) return 'skip_ask';
  if (plan.origin === 'ai') return plan;
  if (plan.aiReason !== null) return `failed_${plan.aiReason}`;
  return plan.status === 'saved' ? 'skip_local' : `skip_${plan.status}`;
}

/** 识别出了字：先按本机规则存，存成了后台整理。t0 = 松手（或识别自己结束）的时刻，LIVE_LATE_MS 和日志 ms= 从这里算 */
export function createQuickSave(c: VoiceCore) {
  const tidy = async (m: BatchMark, text: string, ctx: TypeCtx, t0: number): Promise<void> => {
    const t1 = performance.now();
    const d = c.d();
    const got = parsePlan((await planText(text, ctx, { online: d.online, aiOn: d.aiOn(), call: d.callAi })).plan);
    let out: TidyOut;
    if (typeof got === 'string') out = got;
    else if (performance.now() - t0 > LIVE_LATE_MS) out = 'skip_late';
    else {
      const free = getBoot()?.upgrade.holdBusy('recording');
      try {
        out = await c.batch.replace(m, got, text);
      } finally {
        free?.();
      }
    }
    rlog(`voice live ai via=parse out=${out} ms=${Math.round(performance.now() - t1)}`);
  };
  return async (a: Attempt, text: string, t0: number): Promise<void> => {
    const d = c.d();
    // 语音不带选中的日子（FA-3）：先存和 AI 整理都按这一份，两边才比得上
    const ctx: TypeCtx = { ...d.ctx(), day: null };
    const local = (await planText(text, ctx, { online: d.online, aiOn: false, call: d.callAi })).plan;
    if (!c.alive(a, 'live_plan')) return;
    const empty = local.items.length === 0 && !local.ask;
    // 本机一条都拆不出来：当场交 ai-parse 整理再存
    const plan = empty ? (await planText(text, ctx, { online: d.online, aiOn: d.aiOn(), call: d.callAi, signal: a.ac.signal })).plan : local;
    if (!c.alive(a, 'live_plan_ai')) return;
    const out = await c.savePlan(a, plan, text);
    rlog(`voice live saved out=${out} n=${plan.items.length} ai=${empty ? 1 : 0} ms=${Math.round(performance.now() - t0)}`);
    const m = out === 'ok' && !empty ? c.batch.mark() : null;
    if (m) void tidy(m, text, ctx, t0);
    else rlog(`voice live ai skip why=${empty ? 'done' : out}`);
  };
}
