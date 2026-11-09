// kit 设置组件的第二个文件（Settings.tsx 超 300 行，B2-UI-b W3、W4 拆开；各组件说明见 Settings.tsx 文件头，使用方一律从 Settings.tsx 引）：
// SettingsChoiceCard、SettingsTimesRow、SettingsActionRow（W1）；SettingsList、SettingsDetailRow（W3、W4）。样式同用 Settings.module.css
import { useId, type ReactNode } from 'react';
import form from '../Form.module.css';
import styles from './Settings.module.css';

export interface SettingsChoice<T extends string> {
  value: T;
  label: string;
  testId?: string;
}

export interface SettingsChoiceCardProps<T extends string> {
  /** 组名（radiogroup 的名字） */
  title: string;
  /** 组名写在卡片上方、看得见（默认只给读屏） */
  showTitle?: boolean;
  /** radio 的 name，同页唯一 */
  name: string;
  options: readonly SettingsChoice<T>[];
  value: T;
  /** 点哪一项回调哪一项，亮着的那项再点也回调（用 click 不用 change；方向键切换时浏览器同样派 click） */
  onPick(v: T): void;
  note?: ReactNode;
  testId?: string;
}

export function SettingsChoiceCard<T extends string>({ title, showTitle, name, options, value, onPick, note, testId }: SettingsChoiceCardProps<T>) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-testid={testId}>
      <h2 id={id} className={showTitle === true ? styles.gt : styles.srOnly}>
        {title}
      </h2>
      <div className={styles.grp} role="radiogroup" aria-labelledby={id}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <label key={o.value} className={styles.choice} data-on={on ? '1' : undefined}>
              <input
                type="radio"
                className={styles.srOnly}
                name={name}
                value={o.value}
                checked={on}
                onChange={() => undefined}
                onClick={() => onPick(o.value)}
                data-testid={o.testId}
              />
              <span className={styles.tx}>{o.label}</span>
              <span className={styles.check} aria-hidden="true">
                {on ? '✓' : ''}
              </span>
            </label>
          );
        })}
      </div>
      {note === undefined ? null : <p className={styles.note}>{note}</p>}
    </section>
  );
}

export interface SettingsTimeField {
  label: string;
  /** HH:MM */
  value: string;
  onChange(v: string): void;
  testId?: string;
}

/** 一行几个时刻框（免打扰“从 / 到”）；每个框连同前面的字是一个 label */
export function SettingsTimesRow({ fields, rowId }: { fields: readonly SettingsTimeField[]; rowId?: string }) {
  return (
    <li className={`${styles.row} ${styles.timesRow}`} data-row-id={rowId}>
      {fields.map((f) => (
        <label key={f.label} className={styles.timeLbl}>
          {f.label}
          <input type="time" className={`${form.input} ${styles.time}`} value={f.value} onChange={(e) => f.onChange(e.currentTarget.value)} data-testid={f.testId} />
        </label>
      ))}
    </li>
  );
}

export interface SettingsActionRowProps {
  label: string;
  /** 右边的行内按钮（例如 FormButton）；和 value 二选一，都给时显示 action */
  action?: ReactNode;
  /** 右边的值（灰字，单行省略） */
  value?: ReactNode;
  valueTestId?: string;
  testId?: string;
  rowId?: string;
}

/** 行名 + 右边一个行内按钮或一个值（不是整行可点；整行可点用 SettingsEntryRow） */
export function SettingsActionRow({ label, action, value, valueTestId, testId, rowId }: SettingsActionRowProps) {
  return (
    <li className={`${styles.row} ${styles.actRow}`} data-testid={testId} data-row-id={rowId}>
      <span className={styles.tx}>{label}</span>
      {action === undefined ? (
        <span className={styles.v} data-testid={valueTestId}>
          {value}
        </span>
      ) : (
        <span className={styles.act}>{action}</span>
      )}
    </li>
  );
}

/** 一组行，不带卡名（见文件头） */
export function SettingsList({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <ul className={styles.grp} data-testid={testId}>
      {children}
    </ul>
  );
}

export interface SettingsMeta {
  text: ReactNode;
  /** 危险色（例如“通知邮件没发出去”） */
  danger?: boolean;
  testId?: string;
}

export interface SettingsDetailRowProps {
  /** 行名，可以带标签（“本机”“已退出”） */
  label: ReactNode;
  /** 行名元素的 id（右边按钮用 aria-labelledby 指它时给） */
  labelId?: string;
  /** 右边的行内按钮（FormButton 等）；和 value 二选一，都给时两个都显示 */
  action?: ReactNode;
  /** 右边的值（灰字、靠右，长了换行、不省略） */
  value?: ReactNode;
  valueTestId?: string;
  /** 下面的灰字，一项一行 */
  metas?: readonly SettingsMeta[];
  testId?: string;
  /** 本机那一行（写 data-current="1"，测试按它找） */
  current?: boolean;
}

/** 多段的一行（见文件头）。行名占满剩下的宽度，右边的按钮、值靠右 */
export function SettingsDetailRow({ label, labelId, action, value, valueTestId, metas, testId, current }: SettingsDetailRowProps) {
  return (
    <li className={styles.row} data-testid={testId} data-current={current === true ? '1' : undefined}>
      <span id={labelId} className={`${styles.tx} ${styles.grow}`}>
        {label}
      </span>
      {value === undefined ? null : (
        <span className={styles.end} data-testid={valueTestId}>
          {value}
        </span>
      )}
      {action}
      {metas?.map((m) => (
        <p key={m.testId ?? String(m.text)} className={m.danger === true ? `${styles.meta} ${styles.danger}` : styles.meta} data-testid={m.testId}>
          {m.text}
        </p>
      ))}
    </li>
  );
}
