// 设置页的卡片、行、分段按钮
// • SettingsCard：<section aria-labelledby> + 看不见的 <h2>（卡名，必填）+ <ul>（每张卡一个看不见的标题，行名不做标题）
// • SettingsEntryRow：整行一个按钮“行名 + 当前值 + ›”，点进二级页。值可以先空着（懒加载的值晚到，行一开始就能点），
//   值单行省略、行名不缩；例外：stacked 时值放在行名下面一行、可换行不省略（设置首页账号一行）；meta 是行里的第二行灰字
// • SettingsSwitchRow：<label> 包行名和 role="switch" 的复选框；说明（note）和报错（error）写在这一行里、不挂在卡片下面，
//   说明用 aria-describedby 挂到开关上
// • SettingsSegRow：行名 + 分段按钮（界面语言）。分段按钮就是 kit 的 ModeSeg look="slide"，不另写一份，组名取行名（aria-labelledby）
// • 行里的第二行灰字（meta）和报错（error）三种行共用 RowNotes（SettingsRows.tsx）：报错一律 role="status"
// • SettingsInfoRow：只显示的一行“行名 + 值”，不能点（关于页的版本号）
// • SettingsRow：别的内容自己放
// • 日历设置、提醒设置用的：
//   SettingsCard 的 showTitle（卡名写在卡片上方看得见，日历“节假日”）和 note（卡片下面一句说明）；
//   SettingsChoiceCard：一组单选，每项一行、选中的右边打“✓”（原生 radio 视觉隐藏，整行是 label，方向键照常切换；点亮着的那项也回调）；
//   SettingsTimesRow：一行几个时刻（免打扰“从 / 到”），带 kit 选择器，单独在 SettingsTimesRow.tsx、用的页直接从那里引（不让整个设置页带上选择器）；
//   SettingsActionRow：行名 + 右边一个行内按钮或一个值（提醒“通知”一行：没授权时是“打开”按钮，授权后是状态）
// • 设置页账号、数据、电脑三页用的：
//   SettingsList：只有一组行、没有卡名（标题由使用方自己写在外面，例如“已登录设备”要能接焦点）；
//   SettingsDetailRow：多段的一行——行名（可带标签）+ 右边按钮或值（值可换行、不省略）+ 下面一行或几行灰字（已登录设备、最近的导出、快捷键）；
//   SettingsEntryRow 的 danger（危险色整行，“注销账号”）、describedBy、busy（“导出全部数据”）
// • 设置 › 账号的 iOS 分组表用的：
//   SettingsIcon：行名前面的小方块图标（accent 时柠檬黄底），放进 SettingsEntryRow / SettingsDetailRow 的 lead；
//   组里有图标时分隔线从行名起画、不从图标下面穿过（样式见 Settings.module.css 的 .ico 一节）；
//   SettingsEntryRow 的 center（字居中、不带 ›，“退出其他所有设备”“注销账号”各自一组，都用 danger）、chev={false}（不带 ›，“去掉头像”）
// 文案一律由使用方传进来，这里不认 i18n 键
import { useId, type ReactNode } from 'react';
import { Pressable } from '../../../motion/components.ts';
import form from '../Form.module.css';
import { ModeSeg } from '../ModeSeg.tsx';
import { RowNotes } from './SettingsRows.tsx';
import styles from './Settings.module.css';

/** 卡下那种灰字说明的类名（设置页卡外的说明也用它，样式只在 Settings.module.css 的 .note 一处） */
export const settingsNoteClass = styles.note;
/** 行里第二行灰字、行里报错的类名（RowNotes 用的同一份；账号页头像旁边那句说明、失败提示也用它，不在页面里另写） */
export const settingsMetaClass = styles.meta;
export const settingsErrorClass = styles.error;
/** 同一句说明、下边再隔 16 把下一张卡隔开（SettingsCard 的 note 就是这个；提醒页卡下说明也用它） */
export const settingsCardNoteClass = `${styles.note} ${styles.cardNote}`;

export interface SettingsCardProps {
  title: string;
  children: ReactNode;
  testId?: string | undefined;
  /** 卡名写在卡片上方、看得见（默认只给读屏） */
  showTitle?: boolean | undefined;
  /** 卡片下面的一句说明（灰字） */
  note?: ReactNode | undefined;
  noteTestId?: string;
  /**
   * 卡里是一组单选（SettingsChoiceCard）：外框换成 role="radiogroup" 的 div，组名同卡名；
   * 'checks' 是一组多选（同样的行、右边打“✓”，只是能勾几项，例如 AI 服务商的联网搜索）：外框是 role="group" 的 div，样子一样
   */
  radio?: boolean | 'checks';
}

export function SettingsCard({ title, children, testId, showTitle, note, noteTestId, radio }: SettingsCardProps) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-testid={testId}>
      <h2 id={id} className={showTitle === true ? `${form.groupLabel} ${styles.gt}` : styles.srOnly}>
        {title}
      </h2>
      {radio === true || radio === 'checks' ? (
        <div className={styles.grp} role={radio === true ? 'radiogroup' : 'group'} aria-labelledby={id}>
          {children}
        </div>
      ) : (
        <ul className={styles.grp}>{children}</ul>
      )}
      {note === undefined ? null : (
        <p className={settingsCardNoteClass} data-testid={noteTestId}>
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
  SettingsIcon,
  SettingsList,
  RowNotes,
  type SettingsActionRowProps,
  type SettingsChoice,
  type SettingsChoiceCardProps,
  type SettingsDetailRowProps,
  type SettingsMeta,
} from './SettingsRows.tsx';

export function SettingsRow({ children, testId, rowId }: { children: ReactNode; testId?: string; rowId?: string }) {
  return (
    <li className={styles.row} data-testid={testId} data-row-id={rowId}>
      {children}
    </li>
  );
}

/** 只显示、不能点的一行：行名 + 值（例如关于页的“版本 4.0.0”） */
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
  /** 行名；一般是字符串，设置首页账号一行是插了 <wbr> 的邮箱 */
  label: ReactNode;
  /** 行名前面的东西（可选，例如设置首页账号一行的头像圈）；只是装饰，读屏只念行名 */
  lead?: ReactNode;
  /** 行名和值上下两行：值放在行名下面、可换行、不省略（设置首页账号一行：长邮箱、“设备列表读不出来”不能被截断） */
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
   * （GlassBarFx 的 NOT_NAV，危险操作不许被过渡误触发）。所以“只要红字、可以代点”的行不要用它
   */
  danger?: boolean;
  /** 说明写在行外面时，说明元素的 id（aria-describedby；有 meta 时用 meta） */
  describedBy?: string | undefined;
  /** 正在处理（aria-busy） */
  busy?: boolean;
  /** 字居中、不带 ›、不显示值（单独一组的红字操作行） */
  center?: boolean;
  /** false 时不带 ›（“去掉头像”：点了直接做，不进二级页）；默认带 */
  chev?: boolean;
}

export function SettingsEntryRow({ label, lead, stacked, value, meta, onOpen, testId, valueTestId, disabled, rowId, danger, describedBy, busy, center, chev }: SettingsEntryRowProps) {
  const metaId = useId();
  return (
    <li className={styles.row} data-row-id={rowId}>
      <Pressable
        className={[styles.rowBtn, danger === true && styles.danger, center === true && styles.center].filter(Boolean).join(' ')}
        onClick={onOpen}
        data-testid={testId}
        disabled={disabled}
        aria-busy={busy}
        aria-describedby={meta === undefined ? describedBy : metaId}
        // 危险的整行不让底栏过渡代点（GlassBarFx 的 NOT_NAV）
        data-no-proxy={danger === true ? '' : undefined}
      >
        {lead}
        {center === true ? (
          <span className={styles.tx}>{label}</span>
        ) : stacked ? (
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
        {center === true || chev === false ? null : (
          <span className={styles.chev} aria-hidden>
            ›
          </span>
        )}
      </Pressable>
      <RowNotes metaId={metaId} meta={meta} />
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
      <RowNotes metaId={noteId} meta={note} error={error} />
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

export interface SettingsSegRowProps<T extends string> {
  label: string;
  options: readonly SegOption<T>[];
  value: T;
  onChange(v: T): void;
  /** 分段按钮那一组的 data-testid */
  testId?: string;
  meta?: ReactNode;
  error?: ReactNode;
  rowId?: string;
}

/** 行名 + 分段按钮（kit ModeSeg look="slide"）；meta 是第二行灰字（界面语言的缩短说明），error 是行里的报错（同步失败） */
export function SettingsSegRow<T extends string>({ label, options, value, onChange, testId, meta, error, rowId }: SettingsSegRowProps<T>) {
  const id = useId();
  const metaId = useId();
  return (
    <li className={`${styles.row} ${styles.segRow}`} data-row-id={rowId}>
      <span id={id} className={styles.tx}>
        {label}
      </span>
      <ModeSeg
        look="slide"
        labelledBy={id}
        describedBy={meta === undefined ? undefined : metaId}
        testId={testId}
        items={options.map((o) => ({ key: o.value, label: o.label, lang: o.lang, testId: o.testId, pressed: o.value === value, onClick: () => onChange(o.value) }))}
      />
      <RowNotes metaId={metaId} meta={meta} error={error} />
    </li>
  );
}
