// 本机库来自更新的版本时的静态回退（K6-ver-new 复审 S1、S2）：整屏组件懒加载失败（离线、chunk 丢了）或渲染出错时显示
// 不懒加载、不用动效：一句话“本机数据是新版本写的，请更新 App”加“刷新”；用已经加载好的 i18n
// 仍然不给继续使用；焦点落在“刷新”
import { useEffect, useRef } from 'react';
import { useT } from '../kit/hooks/useT.ts';
import styles from './CacheTooNewScreen.module.css';

export function CacheTooNewFallback({ onRefresh }: { onRefresh(): void }) {
  const t = useT();
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    btn.current?.focus();
  }, []);
  return (
    <div className={styles.screen} role="alertdialog" aria-modal="true" aria-labelledby="cache-too-new-title" data-testid="cache-too-new-fallback">
      <div className={styles.card}>
        <h1 id="cache-too-new-title" className={styles.title}>
          {t('update.tooNew.title', {})}
        </h1>
        <div className={styles.actions}>
          <button ref={btn} type="button" className={styles.primary} onClick={onRefresh}>
            {t('update.tooNew.refresh', {})}
          </button>
        </div>
      </div>
    </div>
  );
}
