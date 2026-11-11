// 键盘上方输入辅助条诊断（台账 Q-11，11-11 负责人“这个框有什么用？没啥用就去掉”“一定要去掉”）：iOS 键盘上方系统的 ∧ ∨ ✓ 那条
// 只在非正式版的诊断区（设置 › 关于 › 连点版本 5 下，VhProbe 的“Keyboard bar test”）里按需下载（React.lazy），正式构建随 VhProbe 一起摇掉，
// build/check_no_probe.mjs 的 PROBE_MARKERS 登记了 KbAccessoryProbe、kbacc-probe、Keyboard bar test 兜底。
// 全屏测试层：A～I 每个用一种写法，旁边一行英文说明（诊断区按钮、说明都是英文、不进词典，A20 只管汉字）；负责人真机逐个点，报哪几个没有那条。
// 依据（WebKit WKContentViewInteraction.mm）：requiresAccessoryView 里，iPhone（小屏）上文字类输入（text、search、textarea、contenteditable……）
// 的 _elementTypeRequiresAccessoryView 一律 YES；能关掉的 accessoryViewShouldNotShow 只有原生宿主经私有接口（_WKFormInputSession）能设。
// inputmode="none" 时 _shouldShowKeyboardForElement 返回 NO（连键盘都不出），G 当对照用。其余几条是网上的说法，等真机实测
// I（11-11 负责人发来的文章“iOS 26 中如何隐藏 Safari 键盘与输入框之间的表单默认按钮”方法一）：::-webkit-input-accessory-view { display:none }；文章方法二那组属性即 E
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FormButton } from '../../../kit/components/Form.tsx';
import styles from './KbAccessoryProbe.module.css';

export const KB_TEST_CLOSE = 'Close';
export const KB_TEST_TITLE = 'Keyboard bar test';

interface Case {
  readonly id: string;
  readonly note: string;
}

/** A～I：编号、说明（英文） */
export const KB_CASES: readonly Case[] = [
  { id: 'A', note: 'Plain text input inside a <form> (same as the + type bar now)' },
  { id: 'B', note: 'Text input, no <form>; other fields disabled while focused (no prev/next field)' },
  { id: 'C', note: 'textarea element, rows=1' },
  { id: 'D', note: 'contenteditable <div>' },
  { id: 'E', note: 'enterkeyhint=done, autocomplete/autocorrect/spellcheck off' },
  { id: 'F', note: 'readonly at tap, readonly removed right after focus (tap again if no keyboard)' },
  { id: 'G', note: 'inputmode=none (control: no keyboard expected)' },
  { id: 'H', note: 'B + E + F combined, no <form>' },
  { id: 'I', note: 'CSS ::-webkit-input-accessory-view { display: none } (from the article)' },
];

/** B、H：聚焦时把别的测试框都禁用（没有上一个、下一个可跳的框），失焦恢复 */
function useSolo(root: React.RefObject<HTMLElement | null>) {
  return {
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      for (const el of root.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ?? []) if (el !== e.currentTarget) el.disabled = true;
    },
    onBlur: () => {
      for (const el of root.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ?? []) el.disabled = false;
    },
  };
}

/** F、H：按下时是只读（不弹键盘），聚焦后下一轮去掉只读；失焦再加回 */
const unlockSoon = (e: React.FocusEvent<HTMLInputElement>): void => {
  const el = e.currentTarget;
  setTimeout(() => el.removeAttribute('readonly'), 0);
};
const relock = (e: React.FocusEvent<HTMLInputElement>): void => e.currentTarget.setAttribute('readonly', '');

export default function KbAccessoryProbe({ onClose }: { onClose(): void }) {
  const root = useRef<HTMLDivElement>(null);
  const solo = useSolo(root);
  const [focused, setFocused] = useState('-');
  useEffect(() => {
    const onIn = (e: FocusEvent): void => setFocused((e.target as HTMLElement | null)?.dataset['case'] ?? '-');
    document.addEventListener('focusin', onIn);
    return () => document.removeEventListener('focusin', onIn);
  }, []);
  const row = (c: Case, field: ReactNode) => (
    <div className={styles.row} key={c.id}>
      <span className={styles.id}>{c.id}</span>
      <div className={styles.cell}>
        {field}
        <span className={styles.note}>{c.note}</span>
      </div>
    </div>
  );
  const [a, b, c, d, e, f, g, h, i] = KB_CASES as [Case, Case, Case, Case, Case, Case, Case, Case, Case];
  return createPortal(
    <div className={styles.layer} ref={root} role="dialog" aria-label={KB_TEST_TITLE} data-testid="kbacc-probe">
      <div className={styles.head}>
        <strong>{KB_TEST_TITLE}</strong>
        <FormButton size="compact" data-testid="kbacc-probe-close" onClick={onClose}>
          {KB_TEST_CLOSE}
        </FormButton>
      </div>
      <p className={styles.note}>Tap each field. Note which letters show NO bar (up / down / check) above the keyboard. Focused: {focused}</p>
      <form className={styles.form} onSubmit={(ev) => ev.preventDefault()}>
        {row(a, <input className={styles.field} type="text" data-case="A" data-testid="kbacc-probe-A" aria-label="Case A" />)}
      </form>
      {row(b, <input className={styles.field} type="text" data-case="B" data-testid="kbacc-probe-B" aria-label="Case B" onFocus={solo.onFocus} onBlur={solo.onBlur} />)}
      {row(c, <textarea className={styles.field} rows={1} data-case="C" data-testid="kbacc-probe-C" aria-label="Case C" />)}
      {row(
        d,
        <div
          className={styles.field}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          tabIndex={0}
          data-case="D"
          data-testid="kbacc-probe-D"
          aria-label="Case D"
        />,
      )}
      {row(
        e,
        <input
          className={styles.field}
          type="text"
          enterKeyHint="done"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-case="E"
          data-testid="kbacc-probe-E"
          aria-label="Case E"
        />,
      )}
      {row(f, <input className={styles.field} type="text" readOnly onFocus={unlockSoon} onBlur={relock} data-case="F" data-testid="kbacc-probe-F" aria-label="Case F" />)}
      {row(g, <input className={styles.field} type="text" inputMode="none" data-case="G" data-testid="kbacc-probe-G" aria-label="Case G" />)}
      {row(
        h,
        <input
          className={styles.field}
          type="text"
          enterKeyHint="done"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          readOnly
          data-case="H"
          data-testid="kbacc-probe-H"
          aria-label="Case H"
          onFocus={(ev) => {
            solo.onFocus(ev);
            unlockSoon(ev);
          }}
          onBlur={(ev) => {
            solo.onBlur();
            relock(ev);
          }}
        />,
      )}
      {row(i, <input className={`${styles.field} ${styles.noAcc}`} type="text" data-case="I" data-testid="kbacc-probe-I" aria-label="Case I" />)}
    </div>,
    document.body,
  );
}
