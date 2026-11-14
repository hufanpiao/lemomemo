// 提示条下面那一行“也帮你找了一下：N 条 ›”“是要取消吗？找到 N 条 ›”（B4b-3，架构 5.14 第 2、7 点“模糊：先按记下保存，同时给查找结果”）
// • 经 index.ts 的 AssistPeek 懒加载，features/plus 的 SavedNotice 挂；条数在本机缓存里数（同结果层同一套，不调 AI），排除刚保存的这一批
// • 一条都没有就不画；点了打开结果层（openAssist，from notice、不带“改成记下”：已经存过了）。
//   取消、改期、完成在卡片里确认了以后撤销刚保存的这一批（undoSaved，架构 5.14 第 7 点“用户在卡片里确认后，撤销刚保存的那一批”）
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { openAssist, usesFindPanel } from '../hooks/find-open.ts';
import { useAssistCount } from '../hooks/useAssist.ts';
import styles from './FindPanel.module.css';
import { useFindT } from './find-parts.tsx';

export interface AssistPeekProps {
  ask: AssistAsk;
  /** 刚保存的这一批的 id */
  exclude: readonly string[];
  /** 撤销刚保存的这一批（取消、改期、完成确认以后调） */
  undoSaved(): Promise<unknown>;
}

export default function AssistPeek({ ask, exclude, undoSaved }: AssistPeekProps) {
  const t = useFindT();
  const n = useAssistCount(ask, exclude);
  if (n === 0) return null;
  const key = 'query' in ask ? 'as.peek.query' : (`as.peek.${ask.intent}` as const);
  return (
    <button
      type="button"
      className={styles.link}
      onClick={() => {
        rlog(`assist peek open intent=${ask.intent} n=${n} panel=${usesFindPanel(ask) ? 'find' : 'assist'}`);
        openAssist({ ask, raw: '', aiUsed: 0, from: 'notice', record: null, exclude, undoSaved: 'target' in ask ? undoSaved : null, edit: null, onClose: null });
      }}
      data-testid="assist-peek"
    >
      {t(key, { n })}
    </button>
  );
}
