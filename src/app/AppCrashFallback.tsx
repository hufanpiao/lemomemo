// App 顶层出错时的静态兜底（root.tsx 的 withCrashFallback 包在根外面）：没接住的渲染错误都落到这里，不白屏
// • 不懒加载、不用动效：出错时分包可能就是坏的；只用已经加载好的公共词典
// • 一句标题加“刷新”按钮，焦点落在“刷新”；样式借 CacheTooNewScreen.module.css
import { useEffect, useRef } from 'react';
import { useT } from '../kit/hooks/useT.ts';
import styles from './CacheTooNewScreen.module.css';

export function AppCrashFallback({ onRefresh }: { onRefresh(): void }) {
  const t = useT();
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    btn.current?.focus();
  }, []);
  return (
    <div className={styles.screen} role="alertdialog" aria-modal="true" aria-labelledby="app-crashed-title" data-testid="app-crash-fallback">
      <div className={styles.card}>
        <h1 id="app-crashed-title" className={styles.title}>
          {t('app.crashed.title', {})}
        </h1>
        <div className={styles.actions}>
          <button ref={btn} type="button" className={styles.primary} onClick={onRefresh}>
            {t('app.crashed.refresh', {})}
          </button>
        </div>
      </div>
    </div>
  );
}
