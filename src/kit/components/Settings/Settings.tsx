// 设置页的卡片、行、分段按钮（SETTINGS-merge-cards；方案 docs/09-路线图/B2-SETTINGS-merge-cards-方案.md 第 4、5、8 节）
// • SettingsCard：<section aria-labelledby> + 看不见的 <h2>（卡名，必填）+ <ul>（M3：每张卡一个看不见的标题，行名不做标题）
// • SettingsEntryRow：整行一个按钮“行名 + 当前值 + ›”，点进二级页。值可以先空着（懒加载的值晚到，行一开始就能点，M4），
//   值单行省略、行名不缩（S3）；例外：stacked 时值放在行名下面一行、可换行不省略（设置首页账号一行）；meta 是行里的第二行灰字
// • SettingsSwitchRow：<label> 包行名和 role="switch" 的复选框；说明（note）和报错（error）写在这一行里、不挂在卡片下面（M2），
//   说明用 aria-describedby 挂到开关上
// • SettingsSegRow + Segmented：行名 + 分段按钮（界面语言，C：留分段按钮），分段按钮的组名取行名（aria-labelledby）
// • SettingsInfoRow：只显示的一行“行名 + 值”，不能点（关于页的版本号）
// • SettingsRow：别的内容自己放
// • B2-UI-b W1 加的（日历设置、提醒设置换 kit 时要用）：
//   SettingsCard 的 showTitle（卡名写在卡片上方看得见，日历“节假日”）和 note（卡片下面一句说明）；
//   SettingsChoiceCard：一组单选，每项一行、选中的右边打“✓”（原生 radio 视觉隐藏，整行是 label，方向键照常切换；点亮着的那项也回调）；
//   SettingsTimesRow：一行几个时刻框（免打扰“从 / 到”），框用 kit 表单的 .input；
//   SettingsActionRow：行名 + 右边一个行内按钮或一个值（提醒“通知”一行：没授权时是“打开”按钮，授权后是状态）
// • B2-UI-b W3、W4 加的（设置页账号、数据、电脑三页换 kit 时要用）：
//   SettingsList：只有一组行、没有卡名（标题由使用方自己写在外面，例如“已登录设备”要能接焦点）；
//   SettingsDetailRow：多段的一行——行名（可带标签）+ 右边按钮或值（值可换行、不省略）+ 下面一行或几行灰字（已登录设备、最近的导出、快捷键）；
//   SettingsEntryRow 的 danger（危险色整行，“注销账号”）、describedBy、busy（“导出全部数据”）
// 文案一律由使用方传进来，这里不认 i18n 键
import { useId, type ReactNode } from 'react';
import { Pressable } from '../../../motion/components.ts';
import form from '../Form.module.css';
import styles from './Settings.module.css';

export interface SettingsCardProps {
  title: string;
  children: ReactNode;
  testId?: string;
  /** 卡名写在卡片上方、看得见（默认只给读屏，M3） */
  showTitle?: boolean;
  /** 卡片下面的一句说明（灰字） */
  note?: ReactNode;
  noteTestId?: string;
}

export function SettingsCard({ title, children, testId, showTitle, note, noteTestId }: SettingsCardProps) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-testid={testId}>
      <h2 id={id} className={showTitle === true ? styles.gt : styles.srOnly}>
        {title}
      </h2>
      <ul className={styles.grp}>{children}</ul>
      {note === undefined ? null : (
        <p className={styles.note} data-testid={noteTestId}>
          {note}
        </p>
      )}
    </section>
  );
}

// 一组单选、时刻行、行内按钮行、不带卡名的组、多段的行在 SettingsRows.tsx（文件超 300 行拆开），从这里一并导出，使用方照旧从本文件引
export {
  SettingsActionRow,
  SettingsChoiceCard,
  SettingsDetailRow,
  SettingsList,
  SettingsTimesRow,
  type SettingsActionRowProps,
  type SettingsChoice,
  type SettingsChoiceCardProps,
  type SettingsDetailRowProps,
  type SettingsMeta,
  type SettingsTimeField,
} from './SettingsRows.tsx';

export function SettingsRow({ children, testId, rowId }: { children: ReactNode; testId?: string; rowId?: string }) {
  return (
    <li className={styles.row} data-testid={testId} data-row-id={rowId}>
      {children}
    </li>
  );
}

/** 只显示、不能点的一行：行名 + 值（例如关于页的“版本 4.0.0”，设计评审 M-1） */
/** alert：这一行是出错提示（行名就是错误文案），读屏马上念（role="alert" 放在行名上，li 照旧是列表项） */
export function SettingsInfoRow({ label, value, testId, valueTestId, alert }: { label: string; value: ReactNode; testId?: string; valueTestId?: string; alert?: boolean }) {
  return (
    <li className={styles.row} data-testid={testId}>
      <span className={styles.tx} role={alert ? 'alert' : undefined}>{label}</span>
      <span className={`${styles.v} ${styles.num}`} data-testid={valueTestId}>
        {value}
      </span>
    </li>
  );
}

export interface SettingsEntryRowProps {
  /** 行名；一般是字符串，设置首页账号一行是插了 <wbr> 的邮箱（韩文复审建议） */
  label: ReactNode;
  /** 行名前面的东西（可选，例如设置首页账号一行的头像圈）；只是装饰，读屏只念行名 */
  lead?: ReactNode;
  /** 行名和值上下两行：值放在行名下面、可换行、不省略（设置首页账号一行，韩文审校 A-4：长邮箱、“设备列表读不出来”不能被截断） */
  stacked?: boolean;
  /** 右边的当前值；undefined 时先空着（懒加载的值还没到），行照样能点 */
  value?: ReactNode;
  /** 第二行灰字（可选） */
  meta?: ReactNode;
  onOpen(): void;
  testId: string;
  valueTestId?: string;
  disabled?: boolean;
  /** 写在 <li data-row-id>，使用方按它找这一行（例如设置页的分组 id） */
  rowId?: string;
  /**
   * 危险操作的入口（“注销账号”），一个参数管两件事：① 危险色字，禁用时照样变灰；② 带 data-no-proxy，底栏切页过渡期间不被代点
   * （GlassBarFx 的 NOT_NAV，危险操作不许被过渡误触发）。所以“只要红字、可以代点”的行不要用它（代码审 W3W4 建议 1，主持人 11-09 定只写注释、不另加参数）
   */
  danger?: boolean;
  /** 说明写在行外面时，说明元素的 id（aria-describedby；有 meta 时用 meta） */
  describedBy?: string;
  /** 正在处理（aria-busy） */
  busy?: boolean;
}

export function SettingsEntryRow({ label, lead, stacked, value, meta, onOpen, testId, valueTestId, disabled, rowId, danger, describedBy, busy }: SettingsEntryRowProps) {
  const metaId = useId();
  return (
    <li className={styles.row} data-row-id={rowId}>
      <Pressable
        className={danger === true ? `${styles.rowBtn} ${styles.danger}` : styles.rowBtn}
        onClick={onOpen}
        data-testid={testId}
        disabled={disabled}
        aria-busy={busy}
        aria-describedby={meta === undefined ? describedBy : metaId}
        // 危险的整行不让底栏过渡代点（GlassBarFx 的 NOT_NAV，设计复审五 R6-a）
        data-no-proxy={danger === true ? '' : undefined}
      >
        {lead}
        {stacked ? (
          <span className={styles.stack}>
            <span className={styles.tx}>{label}</span>
            <span className={`${styles.v} ${styles.vBelow}`} data-testid={valueTestId}>
              {value}
            </span>
          </span>
        ) : (
          <>
            <span className={styles.tx}>{label}</span>
            <span className={styles.v} data-testid={valueTestId}>
              {value}
            </span>
          </>
        )}
        <span className={styles.chev} aria-hidden>
          ›
        </span>
      </Pressable>
      {meta === undefined ? null : (
        <p id={metaId} className={styles.meta}>
          {meta}
        </p>
      )}
    </li>
  );
}

export interface SettingsSwitchRowProps {
  label: string;
  checked: boolean;
  onChange(v: boolean): void;
  /** 行里的第二行说明，挂到开关的 aria-describedby */
  note?: ReactNode;
  /** 行里的报错（role="status"，出现时读屏会念） */
  error?: ReactNode;
  testId: string;
  disabled?: boolean;
  rowId?: string;
}

export function SettingsSwitchRow({ label, checked, onChange, note, error, testId, disabled, rowId }: SettingsSwitchRowProps) {
  const noteId = useId();
  return (
    <li className={styles.row} data-row-id={rowId}>
      <label className={styles.switchRow}>
        <span className={styles.tx}>{label}</span>
        <input
          type="checkbox"
          role="switch"
          className={form.switch}
          checked={checked}
          disabled={disabled}
          aria-describedby={note === undefined ? undefined : noteId}
          onChange={(e) => onChange(e.currentTarget.checked)}
          data-testid={testId}
        />
      </label>
      {note === undefined ? null : (
        <p id={noteId} className={styles.meta}>
          {note}
        </p>
      )}
      {error === undefined || error === null ? null : (
        <p className={styles.error} role="status">
          {error}
        </p>
      )}
    </li>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: string;
  /** 选项文字本身的语言（例如“한국어”标 ko），读屏按这个语言念 */
  lang?: string;
  /** 这一个按钮的 data-testid（可选） */
  testId?: string;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegOption<T>[];
  value: T;
  onChange(v: T): void;
  /** 组名：传行名元素的 id（aria-labelledby），或者直接给 label（aria-label） */
  labelledBy?: string;
  label?: string;
  /** 说明的 id（aria-describedby） */
  describedBy?: string | undefined;
  testId?: string;
}

export function Segmented<T extends string>({ options, value, onChange, labelledBy, label, describedBy, testId }: SegmentedProps<T>) {
  return (
    <div
      className={styles.seg}
      role="group"
      aria-labelledby={labelledBy}
      aria-label={labelledBy === undefined ? label : undefined}
      aria-describedby={describedBy}
      data-testid={testId}
    >
      {options.map((o) => (
        <Pressable key={o.value} className={styles.segBtn} lang={o.lang} aria-pressed={o.value === value} data-value={o.value} data-testid={o.testId} onClick={() => onChange(o.value)}>
          {o.label}
        </Pressable>
      ))}
    </div>
  );
}

export interface SettingsSegRowProps<T extends string> extends Omit<SegmentedProps<T>, 'labelledBy' | 'label' | 'describedBy'> {
  label: string;
  meta?: ReactNode;
  error?: ReactNode;
  rowId?: string;
}

/** 行名 + 分段按钮；meta 是第二行灰字（界面语言的缩短说明，M1），error 是行里的报错（同步失败，role="alert"） */
export function SettingsSegRow<T extends string>({ label, meta, error, rowId, ...seg }: SettingsSegRowProps<T>) {
  const id = useId();
  const metaId = useId();
  return (
    <li className={`${styles.row} ${styles.segRow}`} data-row-id={rowId}>
      <span id={id} className={styles.tx}>
        {label}
      </span>
      <Segmented {...seg} labelledBy={id} describedBy={meta === undefined ? undefined : metaId} />
      {meta === undefined ? null : (
        <p id={metaId} className={styles.meta}>
          {meta}
        </p>
      )}
      {error === undefined || error === null ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
