// 输入时盖住整页的液态模糊玻璃（R-399 打字条后面、R-401 随手记输入行后面共用这一份；样式在 Mist.module.css）
// • 只接手指和鼠标的点（onTap，用 click：一次点按的最后一个事件，处理时这一层还在，卸掉以后不会落到后面看不清的按钮上，不点穿）；
//   键盘用各自输入框的 Esc / Tab 离开，所以这一层不进读屏
// • 画出来记一行 `<tag> mist on fx=…`、卸掉记一行 `<tag> mist off`（运行日志，只记状态和实际生效的滤镜；fx=none 表示走了半透明纯色的后备）
// • 层级默认 --z-mist（在底栏渐隐层、底栏下面）；调用方要压在别的东西下面时，在 className 里把 --z-mist 设成另一个层级令牌（例：随手记设成 --z-notes-mist，在输入行下面）
import { useEffect, useRef } from 'react';
import styles from './Mist.module.css';

export interface MistProps {
  onTap(): void;
  /** 运行日志前缀：typebar、notes */
  tag: string;
  /** 记一行运行日志（调用方传 platform 的 rlog；kit 不直接引 platform） */
  log(line: string): void;
  testId: string;
  /** 只用来改 --z-mist */
  className?: string | undefined;
}

export function Mist({ onTap, tag, log, testId, className }: MistProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const cs = ref.current ? getComputedStyle(ref.current) : null;
    log(`${tag} mist on fx=${cs?.getPropertyValue('backdrop-filter') || cs?.getPropertyValue('-webkit-backdrop-filter') || 'none'}`);
    return () => log(`${tag} mist off`);
  }, [tag, log]);
  return <div ref={ref} className={className ? `${styles.mist} ${className}` : styles.mist} onClick={onTap} aria-hidden="true" data-testid={testId} />;
}
