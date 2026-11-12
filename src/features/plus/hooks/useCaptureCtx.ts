// 打字条和按住录音共用的上下文（B3 FA-2、FA-3）：界面语言、已有的项目名、这一刻能不能用 AI，拼成 type-flow 的 TypeCtx
// • 原来 useTypeBar、useVoice 各写一份（projectsOf、ai.enabled + 同意版本过期），收成这一处
// • AI 开着 = 设置里 ai.enabled 为 true，且同意版本没有明确过期（S1，kit/state/consent-fresh.ts）
import { useCallback, useMemo } from 'react';
import type { DateStr } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { settingValue, type SettingRow } from '../../../core/setting-read.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { consentStale } from '../../../kit/state/consent-fresh.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { readSessionId } from '../../../platform/session.ts';
import type { TypeCtx } from '../data/type-flow.ts';

const projectsOf = (rows: readonly (readonly { project?: unknown }[])[]): string[] => {
  const s = new Set<string>();
  for (const list of rows) for (const r of list) if (typeof r.project === 'string' && r.project !== '') s.add(r.project);
  return [...s];
};

export interface CaptureCtx {
  locale: 'zh' | 'ko';
  /** 调用这一刻能不能用 AI（同意版本过期是模块状态，不一定引起重渲染，所以每次现算） */
  aiOn(): boolean;
  /** 这一刻的 TypeCtx（now 取调用时的钟） */
  ctx(): TypeCtx;
}

export function useCaptureCtx(day: DateStr | null): CaptureCtx {
  const uiLocale = useUi((s) => s.locale);
  const settings = useCollection<SettingRow & { id: string }>('settings');
  const todos = useCollection<{ id: string; project?: unknown }>('todos');
  const events = useCollection<{ id: string; project?: unknown }>('events');
  const projects = useMemo(() => projectsOf([todos, events]), [todos, events]);
  const locale = uiLocale === 'ko-KR' ? 'ko' : 'zh';
  const aiOn = useCallback(() => settingValue(settings, 'ai.enabled') === true && !consentStale(readSessionId()), [settings]);
  const ctx = useCallback((): TypeCtx => ({ now: clock.now(), tz: currentTz(), locale, projects, day }), [locale, projects, day]);
  return { locale, aiOn, ctx };
}
