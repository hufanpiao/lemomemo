// App 顶层出错时的静态兜底（接手清单 K6-sugg3 ⑥）：main.tsx 渲染的根外面包一层错误边界（root.tsx 的 withCrashFallback），
// App、告知页关口、整屏提示自己没接住的渲染错误都落到这里，不白屏
// • 不懒加载、不用动效：出错时分包可能就是坏的；只用已经加载好的公共词典（shared/i18n，中、韩）
// • 一句“哎呀，卡住了”加“刷新一下”（10-29 负责人定稿，R-250）；焦点落在“刷新”
// • 样式借整屏提示那一份（CacheTooNewScreen.module.css，同一种整屏卡片）
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
