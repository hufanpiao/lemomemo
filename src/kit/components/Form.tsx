// 编辑页的表单零件（B2 FA-2）：字段行、文本框、多行文本、下拉、勾选。只管外观和读屏标注，不含任何业务；文案由调用方传
// 文本框、多行文本：输入时只改本地值，失焦（或回车）时才 onCommit（定稿线框“失焦即保存”，不每敲一个字就入队）；
// 没失焦就离开页面（后退、跳走、切后台）时补交一次（useCommitDraft）
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type ComponentProps, type ReactNode } from 'react';
import { hrefOf, navigate, plainClick, type RouteName } from '../../app/router.ts';
import { Pressable } from '../../motion/components.ts';
import cc from './CheckCircle.module.css';
import styles from './Form.module.css';

export function FormGroup({ children }: { children: ReactNode }) {
  return <div className={styles.group}>{children}</div>;
}

/** 一行：左边字段名、右边控件；hint 是控件下面的一行灰字 */
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
      <div className={styles.control}>{children}</div>
      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </div>
  );
}

/**
 * 字段行右边的“值 ›”（R-415 ① 待办编辑页“来源 随手记 · 标题 ›”）：放在 Field 里，单行、放不下省略，整块控件宽都能点、至少 --hit 高。
 * to 是要去的路由和参数（同 navigate 的参数，地址经 hrefOf，A26）；label 是读屏名称（要带上行名，如“来源 随手记 · 标题”：
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
  /** 换掉默认外观（R-350 待办编辑页的子任务行：无框、和行同高）；不传按 title 选标题框或普通输入框 */
  className?: string | undefined;
  /** 多行框的行数（TextArea；纪念日编辑页备注收起时一行，视觉稿 annface） */
  rows?: number;
}

/** useCommitDraft 的可选项 */
export interface CommitDraftOptions {
  /** 这份草稿能不能交（日期框要年份够了才交）；不给都能交。没交成就失焦时，框里退回外面的值（编辑结束、草稿跟着外面的值走） */
  accept?: ((v: string) => boolean) | undefined;
  /** 停笔多久自动交一次（毫秒；随手记正文、标题 800）；不给就只在失焦、离开时交 */
  idleMs?: number | undefined;
  /** 敲进来的字先过一遍（单行标题：粘贴进来的换行变空格） */
  clean?: ((v: string) => string) | undefined;
  /** 这一下改完就交（日期、时刻选择器选完就算定了，iOS 的滚轮没有回车） */
  commitOnChange?: ((v: string) => boolean) | undefined;
}

type DraftEl = HTMLInputElement | HTMLTextAreaElement;

/**
 * 文本草稿（代码审查 M1）：本地值跟着外面的值走（别的设备改了、保存后规整了），编辑中不被打断；
 * 没提交的草稿在这几种时候补交一次：失焦 / 回车（平常的路径）、停笔 idleMs（给了才有）、组件卸载（浏览器后退、点通知跳走、换记录）、
 * pagehide、visibilitychange 变成 hidden（关标签页、iOS 把 PWA 切到后台后被回收，不一定有卸载）。
 * 同一份草稿只交一次；和外面的值一样就不交。编辑中（聚焦着）外面的值变了不打断；不在编辑时草稿跟着外面的值走（没交的在失焦时已经交过或丢掉）。
 * 返回的 bind 是输入框要接的四样（value、onFocus、onChange、onBlur）：kit 的 TextInput、TextArea 照着接上，不各写一遍处理逻辑（R-420 审查第 9 条；
 * 原生元素上不准展开属性（A26 lemo/safe-href），所以四样逐个写）
 */
export function useCommitDraft(value: string, onCommit: (v: string) => void, { accept = () => true, idleMs, clean, commitOnChange }: CommitDraftOptions = {}) {
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
      const v = clean ? clean(e.target.value) : e.target.value;
      setDraft(v);
      if (commitOnChange?.(v)) flush();
    },
    onBlur: (): void => {
      setEditing(false);
      flush();
    },
  };
  return { draft, flush, bind };
}

/** 回车是不是“提交”：中文、韩文输入法组字时的回车是选字（Safari 那一下 isComposing 为假、keyCode 229），这时失焦会丢掉还没上屏的字（Q-21） */
export function enterCommits(e: { key: string; keyCode: number; nativeEvent: { isComposing: boolean } }): boolean {
  return e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229;
}

/** 日期框：年份 ≥ 1900 才算定了（代码审查 S6：逐位敲年份时 0002-、0020-、0202- 都是合法日期，不能各写一次）；空串 = 清掉 */
export function dateReady(v: string): boolean {
  return v === '' || (/^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 1900);
}

/** 日期、时刻选择器选完就交（日期要年份够了才交） */
const pickedDone = { date: dateReady, time: () => true } as const;

export function TextInput({ value, onCommit, type = 'text', title = false, ...p }: CommitProps & { type?: 'text' | 'date' | 'time'; title?: boolean }) {
  const d = useCommitDraft(value, onCommit, { accept: type === 'date' ? dateReady : undefined, commitOnChange: type === 'text' ? undefined : pickedDone[type] });
  return (
    <input
      id={p.id}
      maxLength={p.maxLength}
      disabled={p.disabled}
      placeholder={p.disabled ? undefined : p.placeholder}
      aria-label={p['aria-label']}
      data-testid={p['data-testid']}
      type={type}
      className={p.className ?? (title ? styles.title : styles.input)}
      value={d.bind.value}
      onFocus={d.bind.onFocus}
      onChange={d.bind.onChange}
      onBlur={d.bind.onBlur}
      onKeyDown={(e) => {
        if (type === 'text' && enterCommits(e)) e.currentTarget.blur();
      }}
    />
  );
}

/** 单行标题：粘贴进来的换行变空格 */
const oneLine = (v: string): string => v.replace(/[\r\n]+/g, ' ');

/**
 * 多行文本。随手记编辑器的标题、正文也用它（原 NoteEditPage 的 DraftArea，R-420 审查第 9 条并过来）：
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

/** 下拉：选项的值是字符串（调用方自己映射 null、数字） */
export function Select({
  value, options, onChange, disabled, id, ...p
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange(v: string): void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}) {
  return (
    <select aria-label={p['aria-label']} data-testid={p['data-testid']} id={id} className={styles.select} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * 勾选框。look="circle"（B2-UI-a U2-4）：和列表的完成圆圈同一画法、同一动效（用 CheckCircle.module.css 的类，不另画一份）；
 * look="switch"（B2-UI-b W5，负责人 11-09 定 D2 ①）：开关，role="switch"，画法用本文件样式里的 .switch（和设置页开关同一份，不另画）；
 * 待办“重要”、日程“全天”用它，圆圈只留给“完成”。默认还是系统方形复选框
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
          {input}
          <span className={cc.fill} data-state={state} aria-hidden="true" />
          <span className={cc.tick} data-state={state} aria-hidden="true" />
        </span>
      ) : (
        input
      )}
      {label}
    </label>
  );
}

/**
 * 编辑页的按钮（“清掉”“删除”“撤销”；G11：不用浏览器原生按钮，浅色灰框、深色凸边都不要）：圆角胶囊描边，和设置 › 提醒的按钮一套写法；
 * danger 是“删除”：危险色描边和字（同 RemindSettings 的 .danger）。聚焦 var(--focus)
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'dangerFill' | 'ghost';

const VARIANT: Record<ButtonVariant, string | undefined> = {
  primary: styles.primary,
  secondary: styles.btn,
  danger: styles.danger,
  dangerFill: styles.dangerFill,
  ghost: styles.ghost,
};

/**
 * kit 通用按钮（B2-UI-a U3-1）：五种 variant，高度一律 --hit。原来的写法照用：不写 variant 是 secondary，
 * 只写 danger（布尔）等于 variant="danger"。
 * strong：字重 600（代码审 M2）。primary、dangerFill 本来就是 600；secondary、danger、ghost 默认 400（编辑页“删除”“清掉”），
 * 设置 › 提醒的“重新连接”“移除它…”“取消”原来是 600，传 strong 保持原样（只有任务单写明的颜色可以变，字重不变）
 */
/**
 * size（B2-UI-b W4，D1 ① 外观不变只换实现）：
 * - regular（默认）：上面五种，看得见 --hit（44）。
 * - compact：设置页按钮（R-276）：看得见 38、灰色实底、点击区扩到 44；primary、dangerFill 是确认弹窗那一对。
 * - row：compact 的外观、看得见 44（R-277：页底“退出登录”和设置行一样高）。
 * block：整行宽；compact、row 的灰底按钮整行宽时底色换 --panel、上面隔 16（原设置页 .wide）
 * outline（R-366，负责人 11-09 选 D5 方案 A）：只配合 size="compact" 的次要按钮用，改成透明底 + 1px --inp-line 描边（regular 次要按钮同一种写法），
 *   高度、圆角、点击区、间距都照 compact 不变（账号页“退出其他所有设备”，和下面的“注销账号”入口行分开）；别的 size 传了也不生效
 */
export type ButtonSize = 'regular' | 'compact' | 'row';

export function FormButton({
  danger = false, variant, strong = false, size = 'regular', block = false, outline = false, ...p
}: Omit<ComponentProps<typeof Pressable>, 'className'> & {
  danger?: boolean; variant?: ButtonVariant; strong?: boolean; size?: ButtonSize; block?: boolean; outline?: boolean;
}) {
  const cls = [
    VARIANT[variant ?? (danger ? 'danger' : 'secondary')],
    strong && styles.strong,
    size !== 'regular' && styles.compact,
    size === 'row' && styles.row,
    block && styles.block,
    outline && size === 'compact' && styles.outline,
  ].filter(Boolean).join(' ');
  return <Pressable {...p} className={cls} />;
}
