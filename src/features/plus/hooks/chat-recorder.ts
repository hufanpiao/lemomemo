// AI 助手确认卡片的拆和存（在 AI 里输入也能记日程和待办）：交给 features/ai-chat 的 ChatRecorder（hooks/chat-open.ts）。
// • 拆：打字条同一套本机规则（data/type-flow.ts 的 planLocal → shared/logic/parse 的 parseSplit），只出日程、待办；整份结果交回（confirm、doubts 由卡片处理，
//   过去的月日选了“补记今年 / 明年”才能记，用 type-flow 的 applyConfirm，同打字条确认行）；
//   “明天、周五、下午三点”按调用这一刻、用户所在时区（current_tz）算，项目名认本机已有的（useCaptureCtx 的 projectsOf）
// • 存：打字条同一个保存口（data/capture-save.ts 的 saveCapture：captureRow 拼行、经 outbox 写，离线先进队列，提醒标记照旧），
//   source 'page'（打的字）、origin 'rule'（本机规则拆的，不写简称）；一张卡片一批
// • 放在 plus：本机规则、保存口和打字条、录音用同一份代码，对话那一块不另引一份；由录音那一块（voice-main.ts）加载时登记，
//   同结果层“改成记下”的 setAssistRecorder（放 TypeBarPreload 静态引或 import() 会把打字条那一块拆碎，e2e plus-expand-no-flash 会红）
// • 上下文在点的那一刻现读（ctxNow），不订阅待办、日程整表（useCaptureCtx 那样订阅，每次同步都要多算一遍）
import { fromUiLocale } from '../../../../shared/i18n/pick-locale.ts';
import type { CaptureItem } from '../../../../shared/logic/capture-map.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { collection } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { saveCapture, type Writer } from '../data/capture-save.ts';
import { applyConfirm, planLocal, type TypeCtx } from '../data/type-flow.ts';
import type { ParseResult } from '../../../../shared/logic/parse/parse-split.ts';
import { projectsOf } from './useCaptureCtx.ts';

/** 卡片只记这两类（纪念日、随手记的说法也按待办出，同本机规则没开纪念日时） */
const KINDS = ['event', 'todo'] as const;

type ProjRow = { id: string; project?: unknown } & Record<string, unknown>;

/** 这一刻的上下文（同 useCaptureCtx 的 ctx，只是不订阅） */
function ctxNow(): TypeCtx {
  const projects = projectsOf([collection<ProjRow>('todos').getSnapshot(), collection<ProjRow>('events').getSnapshot()]);
  return { now: clock.now(), tz: currentTz(), locale: fromUiLocale(uiStore.getState().locale), projects, day: null };
}

/** ctx：调用这一刻的 TypeCtx（平时 ctxNow）；w：写入口（测试换成桩，平时是 core/write.ts 的 write） */
export function chatRecorderOf(ctx: () => TypeCtx = ctxNow, w?: Writer) {
  return {
    /** 整份结果交回（items 带 confirm，doubts、hints 给卡片标“没把握”“这天不存在”“重复只记一次”） */
    plan(text: string): ParseResult {
      return planLocal(text, { ...ctx(), day: null, features: KINDS }).result;
    },
    /** 过去的月日：同打字条确认行 */
    confirm: applyConfirm,
    async save(item: CaptureItem, raw: string): Promise<{ table: 'events' | 'todos'; id: string } | null> {
      const c = ctx();
      const r = await saveCapture({ items: [item], rawText: raw, source: 'page', origin: 'rule', now: c.now, tz: c.tz }, w);
      const s = r.ok ? r.saved[0] : undefined;
      return s && (s.table === 'events' || s.table === 'todos') ? { table: s.table, id: s.id } : null;
    },
  };
}
