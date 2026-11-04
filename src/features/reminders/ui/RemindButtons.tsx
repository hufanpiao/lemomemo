// 一条提醒的按钮（按类型固定，shared/logic/remind-actions 的 actionsFor；R-181）：按钮条、整页提醒共用
// 第一个“知道了”是主按钮（柠檬黄）；按了没写进去时在下面提示“没保存上”
import { useState } from 'react';
import type { RemindAction, RemindActionKey } from '../../../../shared/logic/remind-actions.ts';
import { Pressable } from '../../../motion/components.ts';
import type { Reminder } from '../hooks/remind-view.ts';
import { useRemindActions, type ActResult } from '../hooks/useReminders.ts';
import { useRemindT } from '../hooks/useRemindT.ts';
import styles from './Remind.module.css';

const LABEL: Record<RemindActionKey, 'remind.act.ack' | 'remind.act.snooze10' | 'remind.act.atStart' | 'remind.act.hour1' | 'remind.act.tomorrow' | 'remind.act.genTodo'> = {
  ack: 'remind.act.ack',
  snooze10: 'remind.act.snooze10',
  atStart: 'remind.act.atStart',
  hour1: 'remind.act.hour1',
  tomorrow: 'remind.act.tomorrow',
  genTodo: 'remind.act.genTodo',
};

/** layout：'bar' 一排（底部按钮条，线框 ABAR / ABAR4）；'page' 整页提醒——“知道了”整行宽主按钮，其余两颗一排（设计 H1） */
export function RemindButtons({
  r,
  actions,
  onBefore,
  onDone,
  layout = 'bar',
}: {
  r: Reminder;
  actions: readonly RemindAction[];
  onBefore?: () => void;
  onDone?: (a: RemindAction) => void;
  layout?: 'bar' | 'page';
}) {
  const t = useRemindT();
  const { act } = useRemindActions();
  const [fail, setFail] = useState<ActResult | null>(null);
  const [busy, setBusy] = useState(false);
  const btn = (a: RemindAction, i: number) => (
    <Pressable
      key={a.key}
      type="button"
      className={i === 0 ? `${styles.btn} ${styles.primary}` : styles.btn}
      disabled={busy}
      data-testid={`remind-act-${a.key}`}
      onClick={async () => {
        setBusy(true);
        onBefore?.();
        const res = await act(r, a);
        setBusy(false);
        setFail(res === 'ok' || res === 'silent' ? null : res);
        if (res === 'ok') onDone?.(a);
      }}
    >
      {t(LABEL[a.key], {})}
    </Pressable>
  );
  return (
    <>
      {layout === 'page' ? (
        <>
          {actions[0] && btn(actions[0], 0)}
          {actions.length > 1 && <div className={styles.pageRest}>{actions.slice(1).map((a, i) => btn(a, i + 1))}</div>}
        </>
      ) : (
        actions.map(btn)
      )}
      {fail && (
        <p className={styles.error} role="alert">
          {t(fail === 'readonly' ? 'remind.readonly' : 'remind.saveFailed', {})}
        </p>
      )}
    </>
  );
}
