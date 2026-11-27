// 打字条和按住录音共用的上下文：界面语言、已有的项目名、这一刻能不能用 AI，拼成 type-flow 的 TypeCtx
// • useTypeBar、useVoice 只用这一处（projectsOf、ai.enabled + 同意版本过期），不各写一份
// • AI 开着 = 设置里 ai.enabled 为 true，且同意版本没有明确过期（kit/state/consent-fresh.ts）
import { useCallback, useMemo } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { fromUiLocale } from '../../../../shared/i18n/pick-locale.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { projectCounts } from '../../../../shared/logic/todo-projects.ts';
import { currentTz } from '../../../core/current-tz.ts';
import type { SettingRow } from '../../../core/setting-read.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { aiOnFor } from '../../../kit/hooks/ai-on.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { readSessionId } from '../../../platform/session.ts';
import type { TypeCtx } from '../data/type-flow.ts';

/** 已有的项目名（删掉的不算）；AI 助手卡片的保存口（chat-recorder.ts）调用时现算也用这一份 */
export const projectsOf = (rows: readonly (readonly ({ project?: unknown } & Record<string, unknown>)[])[]): string[] => {
  const s = new Set<string>();
  for (const list of rows) for (const r of list) if (isLiveRow(r) && typeof r.project === 'string' && r.project !== '') s.add(r.project);
  return [...s];
};

/** chips：分类签列哪些项目（同待办页项目筛选条）。语言两种写法都给（只从界面语言往下换）：lang 界面语言 zh-CN / ko-KR（实时转写用）、locale 是 TypeCtx 的 zh / ko；
 *  aiOn()：调用这一刻能不能用 AI（同意版本过期是模块状态，不一定引起重渲染，所以每次现算）；ctx()：这一刻的 TypeCtx（now 取调用时的钟） */
export function useCaptureCtx(day: DateStr | null) {
  const lang = useUi((s) => s.locale);
  const settings = useCollection<SettingRow & { id: string }>('settings');
  const todos = useCollection<{ id: string; project?: unknown } & Record<string, unknown>>('todos');
  const events = useCollection<{ id: string; project?: unknown } & Record<string, unknown>>('events');
  const projects = useMemo(() => projectsOf([todos, events]), [todos, events]);
  // 分类签上列的（chips）：和待办页项目筛选条同一份（有没做完的待办的项目，条数多的在前）；识别用的 projects 照旧含日程里的项目名（删掉的不算）
  const chips = useMemo(() => projectCounts(todos, lang).map((p) => p.project), [todos, lang]);
  const locale: TypeCtx['locale'] = fromUiLocale(lang);
  const aiOn = useCallback(() => aiOnFor(settings, readSessionId()), [settings]);
  const ctx = useCallback((): TypeCtx => ({ now: clock.now(), tz: currentTz(), locale, projects, day }), [locale, projects, day]);
  return { lang, locale, aiOn, ctx, chips };
}
