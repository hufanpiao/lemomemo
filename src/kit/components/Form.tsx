// 编辑页的表单零件：字段行、文本框、多行文本、勾选。只管外观和读屏标注，不含任何业务；文案由调用方传
// 文本框、多行文本：输入时只改本地值，失焦（或回车）时才 onCommit（不每敲一个字就入队）；
// 没失焦就离开页面（后退、跳走、切后台）时补交一次（useCommitDraft）
// 下拉、日期、时刻在 kit/components/Pick：这里只留字段行给它的展开格（useFieldSlot），选择器本身不进这个文件（它在首屏闭包里）
import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ComponentProps, type ReactNode,
} from 'react';
import { hrefOf, navigate, plainClick, type RouteName } from '../../app/router.ts';
import { Pressable } from '../../motion/components.ts';
import { composing } from '../hooks/ime.ts';
import cc from './CheckCircle.module.css';
import styles from './Form.module.css';

/** 同一张卡里就地展开的选择器同时只开一个（kit/components/Pick 的 usePickOpen 认它）：开哪个记它的 id，没开为 null */
export interface PickScopeState {
  open: string | null;
  setOpen(id: string | null): void;
}

const PickScopeCtx = createContext<PickScopeState | null>(null);

export const usePickScope = (): PickScopeState | null => useContext(PickScopeCtx);

/** 一组选择器同时只开一个（FormGroup 自带；PickArea 外面没有一组时自己带一层） */
function PickScope({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const v = useMemo(() => ({ open, setOpen }), [open]);
  return <PickScopeCtx.Provider value={v}>{children}</PickScopeCtx.Provider>;
}

export function FormGroup({ children }: { children: ReactNode }) {
  return (
    <div className={styles.group}>
      <PickScope>{children}</PickScope>
    </div>
  );
}

/** 卡片上方的小字分组名（如“详情”）：第三层文字色、等宽字加字距；只是标签，不是标题（读屏照常读字） */
export function GroupLabel({ children }: { children: ReactNode }) {
  return <p className={styles.groupLabel}>{children}</p>;
}

/** 同一个小字分组名的类名：要用 h2、h3、label 当分组名（能接焦点、关联输入框）时挂这个类，样式只在 Form.module.css 一处 */
export const groupLabelClass = styles.groupLabel;

/** 列表页分组标题行的类名（待办页各组；今天页直接引 Form.module.css 的 groupLabel、groupRow，不引这份 JS）：分组名在左、条数在右 */
export const groupRowClass = `${styles.groupLabel} ${styles.groupRow}`;

/** 表单卡片里的一整行按钮（如纪念日“去掉头像”）：和 FieldButton 同一份 .rowBtn，只加左对齐修饰（.start），次要文字色，至少 --hit 高 */
export function FormRowButton(p: Omit<ComponentProps<typeof Pressable>, 'className'>) {
  return <Pressable {...p} className={`${styles.rowBtn} ${styles.start}`} />;
}

/**
 * 字段行右边的“值 ›”按钮（按钮版的 FieldLink）：放在 Field 里，右对齐、次要文字色、单行放不下省略，至少 --hit 高。
 * 点了不跳页、由调用方处理（纪念日编辑页的日期行展开日期框、提醒行打开提醒弹层）。
 * expanded：这一下展开的是下面的一块（日期行）时传，写 aria-expanded，展开时 › 转成朝下；不传就不写 aria-expanded
 */
export function FieldButton({ expanded, children, ...p }: Omit<ComponentProps<typeof Pressable>, 'className' | 'aria-expanded'> & { expanded?: boolean }) {
  return (
    <Pressable {...p} aria-expanded={expanded} className={styles.rowBtn}>
      <span className={styles.linkText}>{children}</span>
      <span className={styles.chev} data-open={expanded === true ? '' : undefined} aria-hidden="true">
        ›
      </span>
    </Pressable>
  );
}

/** 整宽删除行：单独一张卡片、红字居中，和上面的表单卡片同一套圆角；EditShell 底部的“删除”用它 */
export function DeleteRow(p: Omit<ComponentProps<typeof Pressable>, 'className'>) {
  return <Pressable {...p} className={styles.deleteRow} />;
}

/**
 * 字段行给里面的选择器（kit/components/Pick）的两样：行名（选择器头部、读屏名称用）和行下面那一格（slot）。
 * 选择器“就地展开”要占整行宽、排在这一行下面，而它写在右边的控件格里：经 createPortal 画进 slot，读屏和 Tab 顺序照样是“按钮 → 选择器”
 */
export interface FieldSlot {
  label: string;
  slot: HTMLElement | null;
}

const FieldCtx = createContext<FieldSlot | null>(null);

/** 选择器取所在字段行的行名和展开格（不在 Field 里为 null：就地画在自己后面） */
export const useFieldSlot = (): FieldSlot | null => useContext(FieldCtx);

/**
 * 选择器的展开格（Field 和设置页时刻行 SettingsTimesRow 共用）：
 * children 里的选择器拿到行名和展开格（useFieldSlot），展开格画在 children 后面（slotClass 定样式）；
 * 同一组只开一个：外面已经有一组（FormGroup、外层 PickArea）就跟着它，没有就自己带一层
 */
export function PickArea({ label = '', slotClass, children }: { label?: string; slotClass: string | undefined; children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const ctx = useMemo(() => ({ label, slot }), [label, slot]);
  const outer = usePickScope();
  const body = (
    <>
      <FieldCtx.Provider value={ctx}>{children}</FieldCtx.Provider>
      <div ref={setSlot} className={slotClass} />
    </>
  );
  return outer ? body : <PickScope>{body}</PickScope>;
}

/** 一行：左边字段名、右边控件；hint 是控件下面的一行灰字。行下面留一格给就地展开的选择器（空着不占地方，PickArea） */
export function Field({ label, children, hint, htmlFor }: { label: string; children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <div className={styles.field}>
      {htmlFor ? (
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className={styles.label}>{label}</span>
      )}
      <PickArea label={label} slotClass={styles.slot}>
        <div className={styles.control}>{children}</div>
      </PickArea>
      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </div>
  );
}

/**
 * 字段行右边的“值 ›”（如待办编辑页“来源 随手记 · 标题 ›”）：放在 Field 里，单行、放不下省略，整块控件宽都能点、至少 --hit 高。
 * to 是要去的路由和参数（同 navigate 的参数，地址经 hrefOf）；label 是读屏名称（要带上行名，如“来源 随手记 · 标题”：
 * Field 的行名不是链接的名称）；testId 必填：运行日志记元素时 data-testid 在 aria-label 之前，不传就会记下 label 里用户写的标题。普通点击走 navigate，带修饰键的照浏览器默认（plainClick，同 MeLink）
 */
export function FieldLink({ to, label, children, testId }: { to: readonly [RouteName, ...string[]]; label: string; children: ReactNode; testId: string }) {
  return (
    <a className={styles.link} href={hrefOf(...to)} aria-label={label} onClick={(e) => plainClick(e) && void navigate(...to)} data-testid={testId}>
      <span className={styles.linkText}>{children}</span>
      <span aria-hidden="true">›</span>
    </a>
  );
}

interface CommitProps {
  id?: string;
  value: string;
  onCommit(v: string): void;
  maxLength?: number;
  disabled?: boolean;
  placeholder?: string;
  'aria-label'?: string;
  'data-testid'?: string;
  /** 换掉默认外观（如待办编辑页的子任务行：无框、和行同高）；不传按 title 选标题框或普通输入框 */
  className?: string | undefined;
  /** 多行框的行数（TextArea） */
  rows?: number;
}

/** useCommitDraft 的可选项 */
export interface CommitDraftOptions {
  /** 这份草稿能不能交；不给都能交。没交成就失焦时，框里退回外面的值（编辑结束、草稿跟着外面的值走） */
  accept?: ((v: string) => boolean) | undefined;
  /** 停笔多久自动交一次（毫秒；随手记正文、标题 800）；不给就只在失焦、离开时交 */
  idleMs?: number | undefined;
  /** 敲进来的字先过一遍（单行标题：粘贴进来的换行变空格） */
  clean?: ((v: string) => string) | undefined;
}

type DraftEl = HTMLInputElement | HTMLTextAreaElement;

/**
 * 文本草稿：本地值跟着外面的值走（别的设备改了、保存后规整了），编辑中不被打断；
 * 没提交的草稿在这几种时候补交一次：失焦 / 回车（平常的路径）、停笔 idleMs（给了才有）、组件卸载（浏览器后退、点通知跳走、换记录）、
 * pagehide、visibilitychange 变成 hidden（关标签页、iOS 把 PWA 切到后台后被回收，不一定有卸载）。
 * 同一份草稿只交一次；和外面的值一样就不交。编辑中（聚焦着）外面的值变了不打断；不在编辑时草稿跟着外面的值走（没交的在失焦时已经交过或丢掉）。
 * 返回的 bind 是输入框要接的四样（value、onFocus、onChange、onBlur）：kit 的 TextInput、TextArea 照着接上，不各写一遍处理逻辑
 * （原生元素上不准展开属性（lemo/safe-href），所以四样逐个写）
 */
export function useCommitDraft(value: string, onCommit: (v: string) => void, { accept = () => true, idleMs, clean }: CommitDraftOptions = {}) {
  const [draft, setDraftState] = useState(value);
  const [editing, setEditing] = useState(false);
  const latest = useRef({ draft: value, value, onCommit, accept, dirty: false, timer: undefined as ReturnType<typeof setTimeout> | undefined });
  latest.current.value = value;
  latest.current.onCommit = onCommit;
  latest.current.accept = accept;
  useEffect(() => {
    if (editing) return;
    setDraftState(value);
    latest.current.draft = value;
    latest.current.dirty = false;
  }, [value, editing]);

  const flush = useCallback((): void => {
    const l = latest.current;
    clearTimeout(l.timer);
    l.timer = undefined;
    if (!l.dirty) return;
    l.dirty = false;
    if (l.draft !== l.value && l.accept(l.draft)) l.onCommit(l.draft);
  }, []);

  const setDraft = useCallback(
    (v: string): void => {
      setDraftState(v);
      const l = latest.current;
      l.draft = v;
      l.dirty = true;
      if (idleMs === undefined) return;
      clearTimeout(l.timer);
      l.timer = setTimeout(flush, idleMs);
    },
    [flush, idleMs],
  );

  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      flush();   // 卸载时还有没提交的草稿：交一次
    };
  }, [flush]);

  const bind = {
    value: draft,
    onFocus: (): void => setEditing(true),
    onChange: (e: ChangeEvent<DraftEl>): void => {
      setEditing(true);
      setDraft(clean ? clean(e.target.value) : e.target.value);
    },
    onBlur: (): void => {
      setEditing(false);
      flush();
    },
  };
  return { draft, flush, bind };
}

/** 回车是不是“提交”：中文、韩文输入法组字时的回车是选字（判断只在 kit/hooks/ime.ts 一份），这时失焦会丢掉还没上屏的字 */
export function enterCommits(e: { key: string; nativeEvent: { isComposing: boolean; keyCode: number } }): boolean {
  return e.key === 'Enter' && !composing(e.nativeEvent);
}

/** 单行文本框（日期、时刻用 kit/components/Pick 的选择器，不用原生 date / time 框） */
export function TextInput({ value, onCommit, title = false, ...p }: CommitProps & { title?: boolean }) {
  const d = useCommitDraft(value, onCommit);
  return (
    <input
      id={p.id}
      maxLength={p.maxLength}
      disabled={p.disabled}
      placeholder={p.disabled ? undefined : p.placeholder}
      aria-label={p['aria-label']}
      data-testid={p['data-testid']}
      type="text"
      className={p.className ?? (title ? styles.title : styles.input)}
      value={d.bind.value}
      onFocus={d.bind.onFocus}
      onChange={d.bind.onChange}
      onBlur={d.bind.onBlur}
      onKeyDown={(e) => {
        if (enterCommits(e)) e.currentTarget.blur();
      }}
    />
  );
}

/** 单行标题：粘贴进来的换行变空格 */
const oneLine = (v: string): string => v.replace(/[\r\n]+/g, ' ');

/**
 * 多行文本。随手记编辑器的标题、正文也用它：
 * • autoGrow：跟着内容长高（量内容本身的高度写回 height，样式里的 min-height 托底）
 * • single：单行标题，一行起、长了换行显示；回车不换行、当作写完（失焦就交），粘贴进来的换行变空格
 * • idleMs：停笔多久交一次（同 useCommitDraft）
 */
export function TextArea({ value, onCommit, autoGrow = false, single = false, idleMs, ...p }: CommitProps & { autoGrow?: boolean; single?: boolean; idleMs?: number }) {
  const d = useCommitDraft(value, onCommit, { idleMs, clean: single ? oneLine : undefined });
  const el = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = el.current;
    if (!autoGrow || ta === null) return;
    // 量内容本身的高度（先去掉样式里的最小高度）；写回去的 height 再被样式的 min-height 托底
    ta.style.height = 'auto';
    ta.style.minHeight = '0px';
    const h = ta.scrollHeight;
    ta.style.minHeight = '';
    ta.style.height = `${h}px`;
  }, [autoGrow, d.draft]);
  return (
    <textarea
      ref={el}
      id={p.id}
      maxLength={p.maxLength}
      disabled={p.disabled}
      placeholder={p.disabled ? undefined : p.placeholder}
      aria-label={p['aria-label']}
      data-testid={p['data-testid']}
      rows={p.rows ?? (single ? 1 : undefined)}
      className={p.className ?? styles.area}
      value={d.bind.value}
      onFocus={d.bind.onFocus}
      onChange={d.bind.onChange}
      onBlur={d.bind.onBlur}
      onKeyDown={(e) => {
        if (single && enterCommits(e)) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * 勾选框。look="circle"：和列表的完成标记同一画法、同一动效（用 CheckCircle.module.css 的类，不另画一份；画成圆角方框，名字沿用）；
 * look="switch"：开关，role="switch"，画法用本文件样式里的 .switch（和设置页开关同一份，不另画）；
 * 待办“重要”、日程“全天”用它，完成标记只留给“完成”。默认还是系统方形复选框
 */
export function Check({
  label, checked, onChange, disabled, look = 'box', ...p
}: { label: string; checked: boolean; onChange(v: boolean): void; disabled?: boolean; look?: 'box' | 'circle' | 'switch'; 'data-testid'?: string }) {
  const id = useId();
  const input = (
    <input
      data-testid={p['data-testid']}
      id={id}
      type="checkbox"
      role={look === 'switch' ? 'switch' : undefined}
      className={look === 'circle' ? cc.check : look === 'switch' ? styles.switch : undefined}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
  const state = checked ? 'on' : 'off';
  return (
    <label className={styles.check} htmlFor={id}>
      {look === 'circle' ? (
        <span className={`${cc.checkBox} ${styles.circleBox}`}>
          <span className={cc.face}>
            {input}
            <span className={cc.fill} data-state={state} aria-hidden="true" />
            <span className={cc.tick} data-state={state} aria-hidden="true" />
          </span>
        </span>
      ) : (
        input
      )}
      {label}
    </label>
  );
}

/**
 * 编辑页的按钮（“清掉”“删除”“撤销”；不用浏览器原生按钮外观）：圆角胶囊描边，和设置 › 提醒的按钮一套写法；
 * danger 是“删除”：危险色描边和字（同 RemindSettings 的 .danger）。聚焦 var(--focus)
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'dangerFill' | 'ghost' | 'text';

const VARIANT: Record<ButtonVariant, string | undefined> = {
  primary: styles.primary,
  secondary: styles.btn,
  danger: styles.danger,
  dangerFill: styles.dangerFill,
  ghost: styles.ghost,
  text: styles.text,
};

/**
 * kit 通用按钮：六种 variant，高度一律 --hit。text：正文色、不描边、没底色的文字按钮（设置 › 账号设备行右边的“退出这台设备”“移除”），
 * 点击区至少 44 见方，只配合 regular 用。不写 variant 是 secondary，只写 danger（布尔）等于 variant="danger"。
 * strong：字重 600。primary、dangerFill 本来就是 600；secondary、danger、ghost 默认 400（编辑页“删除”“清掉”），
 * 设置 › 提醒的“重新连接”“移除它…”“取消”传 strong
 */
/**
 * size：
 * - regular（默认）：看得见 --hit（44）。
 * - compact：设置页按钮：看得见 38、灰色实底、点击区扩到 44；primary、dangerFill 是确认弹窗那一对。
 * - row：compact 的外观、看得见 44（页底“退出登录”和设置行一样高）。
 * block：整行宽；compact、row 的灰底按钮整行宽时底色换 --panel、上面隔 16
 */
export type ButtonSize = 'regular' | 'compact' | 'row';

export function FormButton({
  danger = false, variant, strong = false, size = 'regular', block = false, ...p
}: Omit<ComponentProps<typeof Pressable>, 'className'> & {
  danger?: boolean; variant?: ButtonVariant; strong?: boolean; size?: ButtonSize; block?: boolean;
}) {
  const cls = [
    VARIANT[variant ?? (danger ? 'danger' : 'secondary')],
    strong && styles.strong,
    size !== 'regular' && styles.compact,
    size === 'row' && styles.row,
    block && styles.block,
  ].filter(Boolean).join(' ');
  return <Pressable {...p} className={cls} />;
}
