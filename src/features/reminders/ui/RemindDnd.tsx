// 设置 › 提醒与通知 › 免打扰（R-347：照线框 sR7 点进去再改；B2 FA-4；remind.dnd）
// • 一行开关：整行是开关的 label，点行里哪儿都能切换（提醒接线设计复审 L5）；打开后一行“从 / 到”两个时刻
// • 开始和结束选成同一时刻：提示、不写；下面一句说明落在免打扰里的提醒怎么办。顶栏、返回由设置页画，这里只画正文
import { useId, useState } from 'react';
import { isHm } from '../hooks/remind-view.ts';
import { useRemindSettings } from '../hooks/useRemindSettings.ts';
import { useRemindT } from '../hooks/useRemindT.ts';
import styles from './RemindSettings.module.css';

type S = ReturnType<typeof useRemindSettings>;

/** 免打扰：开关 + 从 / 到 */
function DndSection({ s, ids }: { s: S; ids: string }) {
  const t = useRemindT();
  const [same, setSame] = useState(false);
  return (
    <section aria-labelledby={`${ids}-dnd`}>
      {/* 组标题只给读屏（行里已经写了“免打扰”，设计 M6 去重） */}
      <h2 id={`${ids}-dnd`} className={styles.srOnly}>
        {t('remind.set.dnd', {})}
      </h2>
      <ul className={styles.grp}>
        <li className={styles.row}>
          <label className={styles.switchRow}>
            <span className={styles.tx}>{t('remind.set.dnd', {})}</span>
            <input
              type="checkbox"
              role="switch"
              className={styles.toggle}
              checked={s.dnd.enabled}
              onChange={(e) => void s.setDnd({ ...s.dnd, enabled: e.currentTarget.checked })}
              data-testid="remind-dnd-on"
            />
          </label>
        </li>
        {s.dnd.enabled && (
          <li className={`${styles.row} ${styles.timesRow}`}>
            <label className={styles.timeLbl}>
              {t('remind.set.dnd.from', {})}
              <input
                type="time"
                className={styles.time}
                value={s.dnd.start}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setSame(v === s.dnd.end);
                  if (isHm(v) && v !== s.dnd.end) void s.setDnd({ ...s.dnd, start: v });
                }}
                data-testid="remind-dnd-start"
              />
            </label>
            <label className={styles.timeLbl}>
              {t('remind.set.dnd.to', {})}
              <input
                type="time"
                className={styles.time}
                value={s.dnd.end}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setSame(v === s.dnd.start);
                  if (isHm(v) && v !== s.dnd.start) void s.setDnd({ ...s.dnd, end: v });
                }}
                data-testid="remind-dnd-end"
              />
            </label>
          </li>
        )}
      </ul>
      {same && (
        <p className={styles.error} role="alert" data-testid="remind-dnd-same">
          {t('remind.set.dnd.same', {})}
        </p>
      )}
      <p className={styles.sn}>{t('remind.set.dnd.note', {})}</p>
    </section>
  );
}

export default function RemindDnd() {
  const t = useRemindT();
  const s = useRemindSettings();
  const ids = useId();
  return (
    <div data-testid="settings-remind-dnd">
      <DndSection s={s} ids={ids} />
      {s.error && (
        <p className={styles.error} role="alert">
          {t('remind.set.saveFailed', {})}
        </p>
      )}
    </div>
  );
}
