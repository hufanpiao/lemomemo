// 待办行的词条（独立评审 11-17 第 9、10 条）：kit TodoRow、useTodoRows 自己的词典（shared/i18n/todo-row-zh.ts、todo-row-ko.ts），
// 待办页、日历日清单的待办组、今天页三处都由 useTodoRows 在这里取，页面不再各拼一份。写法同 useDeskT，语言变了跟着重画
import { todoRowKo } from '../../../shared/i18n/todo-row-ko.ts';
import { todoRowZh } from '../../../shared/i18n/todo-row-zh.ts';
import type { Priority } from '../../../shared/logic/todo-row.ts';
import type { ListToastsProps } from './ListToasts.tsx';
import { makeUseT } from '../hooks/useT.ts';

const useTodoRowT = makeUseT({ zh: todoRowZh, ko: todoRowKo });

/** 行里用到的词条 */
export interface TodoRowWords {
  /** 方框的读屏名字：没勾“完成”，勾了“标成没完成” */
  done: string;
  undoDone: string;
  /** 打勾完成以后撤销条的“已完成” */
  doneToast: string;
  /** 高、中、低 */
  prio(p: Priority): string;
  /** “优先级：中，按一下换成低” */
  prioLine(v: { p: string; next: string }): string;
  /** 副行“起步 / 大半”小标签 */
  stage(s: 1 | 2): string;
  /** 页底提示条 */
  toasts: ListToastsProps['text'];
  /** 过期行尾“推迟”按钮的字、读屏名字“推迟到明天：标题”，推迟以后撤销条的文案 */
  later: string;
  laterLabel(title: string): string;
  laterToast: string;
}

export function useTodoRowWords(): TodoRowWords {
  const t = useTodoRowT();
  return {
    done: t('row.done', {}),
    undoDone: t('row.undoDone', {}),
    doneToast: t('row.doneToast', {}),
    prio: (p) => t(`row.prio.${p}`, {}),
    prioLine: (v) => t('row.prio', v),
    stage: (s) => t(s === 1 ? 'row.stage.1' : 'row.stage.2', {}),
    later: t('row.later', {}),
    laterLabel: (title) => t('row.later.label', { title }),
    laterToast: t('row.later.toast', {}),
    toasts: { deleted: t('row.deleted', {}), undo: t('row.undo', {}), error: t('row.err.save', {}), readonly: t('row.err.readonly', {}) },
  };
}
