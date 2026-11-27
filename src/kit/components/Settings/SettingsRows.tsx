// kit 设置组件的第二个文件（Settings.tsx 超 300 行拆开；各组件说明见 Settings.tsx 文件头，使用方一律从 Settings.tsx 引）：
// SettingsChoiceCard、SettingsActionRow（时刻行 SettingsTimesRow 带选择器，单独在 SettingsTimesRow.tsx）；SettingsList、SettingsDetailRow；SettingsIcon。样式同用 Settings.module.css
import { type ReactNode } from 'react';
import { SwipeRow, type SwipeAction } from '../SwipeRow.tsx';
import { SettingsCard } from './Settings.tsx';
import styles from './Settings.module.css';

/** 行里的第二行灰字（meta，带 id 给 aria-describedby 用）和报错（error，一律 role="status"，出现时读屏会念）；入口行、开关行、分段行共用 */
export function RowNotes({ metaId, meta, error }: { metaId: string; meta?: ReactNode; error?: ReactNode }) {
  return (
    <>
      {meta === undefined ? null : (
        <p id={metaId} className={styles.meta}>
          {meta}
        </p>
      )}
      {error === undefined || error === null ? null : (
        <p className={styles.error} role="status">
          {error}
        </p>
      )}
    </>
  );
}

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
  return (
    <SettingsCard title={title} showTitle={showTitle} note={note} testId={testId} radio>
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
    </SettingsCard>
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
    <li className={styles.row} data-testid={testId} data-row-id={rowId}>
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
  /** 行名前面的小方块图标（SettingsIcon）；给了时行名和灰字上下摞在图标右边，图标上下居中 */
  lead?: ReactNode;
  /** 左滑露出操作（kit SwipeRow，同待办、纪念日的左滑删除）：给了时整行能左滑，行里的内容、样子不变；log 必传（同 SwipeRow） */
  swipe?: { actions: readonly SwipeAction[]; log(line: string): void } | undefined;
}

/** 多段的一行（见文件头）。行名占满剩下的宽度，右边的按钮、值靠右 */
export function SettingsDetailRow({ label, labelId, action, value, valueTestId, metas, testId, current, lead, swipe }: SettingsDetailRowProps) {
  const name = (
    <span id={labelId} className={styles.tx}>
      {label}
    </span>
  );
  const notes = metas?.map((m) => (
    <p key={m.testId ?? String(m.text)} className={m.danger === true ? `${styles.meta} ${styles.danger}` : styles.meta} data-testid={m.testId}>
      {m.text}
    </p>
  ));
  const body = (
    <>
      {lead}
      {lead === undefined ? (
        name
      ) : (
        <span className={styles.stack}>
          {name}
          {notes}
        </span>
      )}
      {value === undefined ? null : (
        <span className={styles.end} data-testid={valueTestId}>
          {value}
        </span>
      )}
      {action}
      {lead === undefined ? notes : null}
    </>
  );
  const cur = current === true ? '1' : undefined;
  if (swipe === undefined) {
    return (
      <li className={styles.row} data-testid={testId} data-current={cur}>
        {body}
      </li>
    );
  }
  // 能左滑的行：li 是 SwipeRow 外框（管分隔线），行面里一层照旧是 .row（内容、行高、上下留白和不滑的行一样）
  return (
    <SwipeRow as="li" className={styles.swipe} actions={swipe.actions} log={swipe.log} {...(testId === undefined ? {} : { 'data-testid': testId })} data-current={cur}>
      <div className={`${styles.row} ${styles.swipeFace}`}>{body}</div>
    </SwipeRow>
  );
}

/** 行名前面的小方块图标：只是装饰（aria-hidden）；accent 时柠檬黄底（本机、更换头像），否则灰底 */
export function SettingsIcon({ accent, children }: { accent?: boolean; children: ReactNode }) {
  return (
    <span className={accent === true ? `${styles.ico} ${styles.icoOn}` : styles.ico} aria-hidden="true">
      {children}
    </span>
  );
}
