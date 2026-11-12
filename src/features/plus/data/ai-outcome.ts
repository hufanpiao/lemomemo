// ai-parse / ai-voice 的返回 → 状态机认的结果（B3 任务单 Q2、FA-1；架构 5.9、5.11 第 4 点）
// • 外部数据一律先过 zod（shared/schema/ai.ts 的 aiResponse），不用 as
// • intent 用穷举 switch：B3 只接 record；不认识的 intent（以后的服务器多出来的）、default 一律当 ai_failed，
//   调用方退回本机规则、原话不丢（Q2 ②，“不是空实现”）。B4b-3 放开 INTENTS 时这里的 switch 编译不过，逼着补分支
// • intent 是 record 但 items 为空：当 ai_failed（empty_items，架构师 11-07 定）
// • 日程、待办的 title、short 超过行约束（shared/schema/rows.ts 的 eventsWrite / todosWrite：160、32，两张表一样）：当读不懂（bad_response），
//   退回本机规则、原话不丢（B3 前端接 ai-parse 安全审 S3）。不然 outbox 入队前按 rows.ts 校验会整行拒掉（invalid_row），整批记不下。
//   纪念日、随手记不查：capture-map 自己截断或不写这几列
// • 不写 ai_status（M5）
// 纯 TS：不准 import React（A1）
import { AI_TEXT_MAX, aiResponse, INTENTS, type AiItem, type Intent } from '../../../../shared/schema/ai.ts';
import { eventsWrite, todosWrite } from '../../../../shared/schema/rows.ts';

/** 状态机能处理的几种结果 */
export type AiOutcome =
  /** 识别成功（B3 只有 record） */
  | { kind: 'record'; items: AiItem[]; quotaLeft: number; transcript: string | null }
  /** 服务器说退回本机规则（feature_off、vault_ai_off、invalid、timeout、error、quota） */
  | { kind: 'fallback'; reason: string }
  /** 还没同意 AI 告知：客户端改用本机规则（打字）或手机自带识别（录音） */
  | { kind: 'consent_required' }
  /** 今天的 AI 次数用完了 */
  | { kind: 'quota_out' }
  /** AI 这次没回应 / 输出不合格 / 不认识的 intent / 返回读不懂 */
  | { kind: 'ai_failed'; reason: string };

/** 打字、录音共用（plus 里只留这一份） */
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** 原话、转写截到 AI_TEXT_MAX 个字（按码点，不切半个表情） */
export const cutAiText = (s: string): string => [...s].slice(0, AI_TEXT_MAX).join('');
const knownIntent = (v: unknown): v is Intent => typeof v === 'string' && (INTENTS as readonly string[]).includes(v);

const ROW_COLS = { event: eventsWrite.shape, todo: todosWrite.shape } as const;

/** 日程、待办这一条的 title、short 放得进行约束（S3） */
function fitsRow(it: AiItem): boolean {
  if (it.kind !== 'event' && it.kind !== 'todo') return true;
  const cols = ROW_COLS[it.kind];
  return cols.title.safeParse(it.title).success && cols.short.safeParse(it.short).success;
}

/** 识别成功那一支按 intent 分派（穷举；default 走退路） */
function byIntent(intent: Intent, items: AiItem[], quotaLeft: number, transcript: string | null): AiOutcome {
  switch (intent) {
    case 'record':
      // “记下”但一条都没有：一律当失败（架构师 11-07 定），调用方退回本机规则、原话不丢；不能当“已记下 0 条”
      if (items.length === 0) return { kind: 'ai_failed', reason: 'empty_items' };
      return { kind: 'record', items, quotaLeft, transcript };
    default: {
      // 运行时只可能是将来放开的新 intent：编译期这里是 never，运行时照样退回本机规则
      const unknownIntent: never = intent;
      return { kind: 'ai_failed', reason: `unknown_intent:${String(unknownIntent)}` };
    }
  }
}

/** 函数返回的 JSON（已 parse）→ 结果。读不懂的一律 ai_failed */
export function outcomeOf(raw: unknown): AiOutcome {
  // 不认识的 intent 先单独认出来（zod 的枚举会把它当“读不懂”，原因不好查）
  if (isObj(raw) && Object.hasOwn(raw, 'intent') && !knownIntent(raw['intent'])) {
    return { kind: 'ai_failed', reason: 'unknown_intent' };
  }
  const r = aiResponse.safeParse(raw);
  if (!r.success) return { kind: 'ai_failed', reason: 'bad_response' };
  const v = r.data;
  if ('intent' in v) {
    if (!v.items.every(fitsRow)) return { kind: 'ai_failed', reason: 'bad_response' };
    return byIntent(v.intent, v.items, v.quota_left, v.transcript ?? null);
  }
  if ('fallback' in v) return { kind: 'fallback', reason: v.reason };
  if ('consent_required' in v) return { kind: 'consent_required' };
  if ('quota_out' in v) return { kind: 'quota_out' };
  return { kind: 'ai_failed', reason: v.reason };
}
