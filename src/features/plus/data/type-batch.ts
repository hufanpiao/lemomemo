// “＋”打字条记下的这一批放在模块里，整页一份（录音那一份由控制器 voice-session.ts 持有，同一个思路）
// • 打字条一收起就直接卸掉；“已记下 · 撤销”提示条由 ui/TypeNotice.tsx（TypeBarPreload 里一直挂着）照这一份画，不跟着打字条卸，
//   照常满 8 秒、能撤销、能合并；再点“＋”新挂的打字条接着用同一份（提示条抬到打字条上方，见 TypeNotice）
// • 打字条挂上时 bind 自己的收尾（flow：状态机、清输入条、失败提示、记下后自动收起）、日历页选中的那天、提示条上的“修改”、测试的写入口；
//   卸掉时只摘掉 flow（之后的 go、fail 不再调），日子、写入口、“修改”留着给提示条上的合并、撤销用
// • 这一批都存好了（done）先清草稿再交给打字条：存的时候打字条已经卸了（整理中收起、换页）也照样清，下次打开不把存过的那句填回来
//   （那时这一批由 hooks/useTypeBar 的 submit 收掉、不出提示条）
// 纯 TS：不准 import React
import type { DateStr } from '../../../../shared/core/date.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { write } from '../../../core/write.ts';
import { clock } from '../../../platform/clock.ts';
import type { Writer } from './capture-save.ts';
import { createBatchBox, createSavedBatch, type BatchFlow, type BatchState } from './saved-batch.ts';
import { clearTypeDraft } from './type-draft.ts';

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

/** 提示条里“修改”用的（最近一次挂上的打字条交来的） */
export const typeOnEdit = (): TypeBind['onEdit'] => bound.onEdit;

/** 提示条现在出着没有（noticeOf 不为 null、确认行没在问；同 hooks/useSavedBatch 的判断） */
export const typeNoticeOn = (s: BatchState): boolean => s.ask.length === 0 && (s.batch?.entries.length ?? 0) > 0;

/** 这一批还在就关掉提示条（换页、提示条卸掉时） */
export function dropTypeNotice(): void {
  if (typeBatch.box.getState().batch) typeBatch.closeNotice();
}
