// 半屏抽屉和盖在它上面的页的顶栏（三栏：左一个按钮、中标题、右一个可选按钮）：AI 助手半屏（ai-chat ChatDrawer）、记住的事（ai-chat MemoryPage）、
// 天气半屏（weather WeatherSheet）共用这一份，原来三处各写一份同样的样式（独立评审 11-26 第 9 条）
// • 左边：close 是“✕ 关闭”（叉 + 字），back 是“‹ 返回”（只有字）；右边没有时空着占位，标题保持居中
// • 调用方要拿左边按钮的 DOM（记住的事打开时焦点给“返回”）就传 btnRef
import type { Ref } from 'react';
import styles from './SheetTop.module.css';

export interface SheetTopBtn {
  label: string;
  onClick(): void;
  testId: string;
  btnRef?: Ref<HTMLButtonElement> | undefined;
}

export interface SheetTopProps {
  title: string;
  left: SheetTopBtn & { kind: 'close' | 'back' };
  right?: SheetTopBtn | undefined;
}

export function SheetTop({ title, left, right }: SheetTopProps) {
  return (
    <div className={styles.top}>
      {left.kind === 'close' ? (
        <button ref={left.btnRef} type="button" className={styles.close} onClick={left.onClick} data-testid={left.testId}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
          {left.label}
        </button>
      ) : (
        <button ref={left.btnRef} type="button" className={styles.back} onClick={left.onClick} data-testid={left.testId}>
          ‹ {left.label}
        </button>
      )}
      <h3 className={styles.h}>{title}</h3>
      {right ? (
        <button ref={right.btnRef} type="button" className={styles.right} onClick={right.onClick} data-testid={right.testId}>
          {right.label}
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}
