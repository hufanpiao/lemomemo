// kit 设置组件：一行几个时刻（免打扰“从 / 到”）。单独一个文件：它要带上 kit 选择器（Pick），
// 放在 Settings.tsx / SettingsRows.tsx 里会让整个设置页都带上选择器；只有用它的页（提醒 › 免打扰）直接从这里引。样式同用 Settings.module.css
import { Fragment } from 'react';
import { PickArea } from '../Form.tsx';
import { DateTimeField } from '../Pick/Pick.tsx';
import styles from './Settings.module.css';

export interface SettingsTimeField {
  label: string;
  /** 选择器头部和读屏名（如“免打扰 从”）；不给用 label */
  title?: string;
  /** HH:MM */
  value: string;
  onChange(v: string): void;
  /** 选的时刻不能等于 value（免打扰“从”“到”）：一样时提示行写 text（红字）、“确定”变灰 */
  notSame?: { value: string; text: string };
  testId?: string;
}

/**
 * 每个时刻是字 + kit 选择器的值按钮（不用原生时刻框），
 * 点了在这一行下面就地展开（PickArea：同一行同时只开一个），“确定”才交；不能清空
 */
export function SettingsTimesRow({ fields, rowId }: { fields: readonly SettingsTimeField[]; rowId?: string }) {
  return (
    <li className={`${styles.row} ${styles.timesRow}`} data-row-id={rowId}>
      <PickArea slotClass={styles.timeSlot}>
        {fields.map((f, i) => {
          const ns = f.notSame;
          return (
            <Fragment key={f.label}>
              <span className={i === 0 ? `${styles.timeK} ${styles.timeK0}` : styles.timeK}>{f.label}</span>
              <span className={styles.timeV}>
                <DateTimeField
                  mode="time"
                  label={f.title ?? f.label}
                  time={f.value}
                  hint={ns ? (v) => (v.time === ns.value ? { text: ns.text, bad: true } : null) : undefined}
                  onDone={(v) => f.onChange(v.time)}
                  testIds={{ time: f.testId }}
                />
              </span>
            </Fragment>
          );
        })}
      </PickArea>
    </li>
  );
}
