// 点依据里的一条：贴底弹层（kit Dialog 的 edge，同今日运势），照方案页“点开条目”的 .sheet：类型小签、标题 20px、第二行灰字、“打开原条目 ›”。
// 参考顶上的把手不画：这个弹层拖不动，画出来是假把手；点后面、Esc 关
// 服务器只回标题、日子、时刻、做没做完，参考里的子任务、优先级那一块没有数据，不画
import type { ChatRef } from '../../../../shared/schema/chat.ts';
import { Dialog, DialogTitle } from '../../../kit/components/Dialog.tsx';
import { openRecord } from '../../../kit/components/RecordMark.tsx';
import { kindName, refMeta, type Locale, type T } from './chat-parts.tsx';
import s from './ChatDrawer.module.css';

export function RefSheet({ r, today, t, locale, onClose, onOpen }: { r: ChatRef | null; today: string; t: T; locale: Locale; onClose(): void; onOpen(): void }) {
  const m = r ? refMeta(r, today, t, locale) : null;
  return (
    <Dialog open={r !== null} onOpenChange={(o) => (o ? undefined : onClose())} edge>
      {r && m ? (
        <div className={s.rs} data-testid="chat-ref-sheet">
          <span className={s.rsKind}>{kindName(r.kind, t)}</span>
          <DialogTitle className={s.rsTitle}>{r.title}</DialogTitle>
          {m.text === '' ? null : <div className={m.late ? `${s.rsMeta} ${s.late}` : s.rsMeta}>{m.text}</div>}
          <button
            type="button"
            className={s.rsGo}
            onClick={() => {
              onOpen();
              openRecord(r.kind, r.id);
            }}
            data-testid="chat-ref-open"
          >
            {t('chat.open', {})} ›
          </button>
        </div>
      ) : null}
    </Dialog>
  );
}
