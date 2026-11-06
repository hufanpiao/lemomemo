// 编辑页的表单零件（B2 FA-2）：字段行、文本框、多行文本、下拉、勾选。只管外观和读屏标注，不含任何业务；文案由调用方传
// 文本框、多行文本：输入时只改本地值，失焦（或回车）时才 onCommit（定稿线框“失焦即保存”，不每敲一个字就入队）；
// 没失焦就离开页面（后退、跳走、切后台）时补交一次（useCommitDraft）
import { useCallback, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Pressable } from '../../motion/components.ts';
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

interface CommitProps {
  id?: string;
  value: string;
  onCommit(v: string): void;
  maxLength?: number;
  disabled?: boolean;
  placeholder?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

/**
 * 文本草稿（代码审查 M1）：本地值跟着外面的值走（别的设备改了、保存后规整了），编辑中不被打断；
 * 没提交的草稿在这几种时候补交一次：失焦 / 回车（平常的路径）、组件卸载（浏览器后退、点通知跳走、换记录）、
 * pagehide、visibilitychange 变成 hidden（关标签页、iOS 把 PWA 切到后台后被回收，不一定有卸载）。
 * 同一份草稿只交一次；和外面的值一样就不交
 */
function useCommitDraft(value: string, onCommit: (v: string) => void, accept: (v: string) => boolean = () => true) {
  const [draft, setDraftState] = useState(value);
  const [editing, setEditing] = useState(false);
  const latest = useRef({ draft: value, value, onCommit, accept, dirty: false });
  latest.current.value = value;
  latest.current.onCommit = onCommit;
  latest.current.accept = accept;
  useEffect(() => {
    if (!editing) {
      setDraftState(value);
      latest.current.draft = value;
      latest.current.dirty = false;
    }
  }, [value, editing]);

  const flush = useCallback((): void => {
    const l = latest.current;
    if (!l.dirty) return;
    l.dirty = false;
    if (l.draft !== l.value && l.accept(l.draft)) l.onCommit(l.draft);
  }, []);

  const setDraft = useCallback((v: string): void => {
    setDraftState(v);
    latest.current.draft = v;
    latest.current.dirty = true;
  }, []);

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

  return { draft, setDraft, setEditing, flush };
}

/** 日期框：年份 ≥ 1900 才算定了（代码审查 S6：逐位敲年份时 0002-、0020-、0202- 都是合法日期，不能各写一次）；空串 = 清掉 */
export function dateReady(v: string): boolean {
  return v === '' || (/^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 1900);
}

export function TextInput({ value, onCommit, type = 'text', title = false, ...p }: CommitProps & { type?: 'text' | 'date' | 'time'; title?: boolean }) {
  const accept = type === 'date' ? dateReady : undefined;
  const d = useCommitDraft(value, onCommit, accept);
  return (
    <input
      id={p.id}
      maxLength={p.maxLength}
      disabled={p.disabled}
      placeholder={p.disabled ? undefined : p.placeholder}
      aria-label={p['aria-label']}
      data-testid={p['data-testid']}
      type={type}
      className={title ? styles.title : styles.input}
      value={d.draft}
      onFocus={() => d.setEditing(true)}
      onChange={(e) => {
        d.setEditing(true);
        d.setDraft(e.target.value);
        // 日期、时刻选择器选完就算定了（iOS 的滚轮没有回车）；日期要年份够了才交
        if (type === 'time' || (type === 'date' && dateReady(e.target.value))) d.flush();
      }}
      onBlur={() => {
        d.setEditing(false);
        d.flush();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && type === 'text') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function TextArea({ value, onCommit, ...p }: CommitProps) {
  const d = useCommitDraft(value, onCommit);
  return (
    <textarea
      id={p.id}
      maxLength={p.maxLength}
      disabled={p.disabled}
      placeholder={p.disabled ? undefined : p.placeholder}
      aria-label={p['aria-label']}
      data-testid={p['data-testid']}
      className={styles.area}
      value={d.draft}
      onFocus={() => d.setEditing(true)}
      onChange={(e) => d.setDraft(e.target.value)}
      onBlur={() => {
        d.setEditing(false);
        d.flush();
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

export function Check({ label, checked, onChange, disabled, ...p }: { label: string; checked: boolean; onChange(v: boolean): void; disabled?: boolean; 'data-testid'?: string }) {
  const id = useId();
  return (
    <label className={styles.check} htmlFor={id}>
      <input data-testid={p['data-testid']} id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/**
 * 编辑页的按钮（“清掉”“删除”“撤销”；G11：不用浏览器原生按钮，浅色灰框、深色凸边都不要）：圆角胶囊描边，和设置 › 提醒的按钮一套写法；
 * danger 是“删除”：危险色描边和字（同 RemindSettings 的 .danger）。聚焦 var(--focus)
 */
export function FormButton({ danger = false, ...p }: Omit<ComponentProps<typeof Pressable>, 'className'> & { danger?: boolean }) {
  return <Pressable {...p} className={danger ? styles.btnDanger : styles.btn} />;
}
