// “最近删除”页（B2 FA-2；ADR-006；TC-B2-03 前两步）：日程和待办，最近删的在前，每条写“N 天后清理”和“恢复”
// • 恢复后出“已恢复”提示（2 秒，role=status）；写不进去出提示条
// • 永久删除、全部清空在 B4（要联网、先弹确认，0.29 续第 121 条⑧）；隐私记有自己的“最近删除”（R-193，B5）
// • 路由 #/trash（app/router.ts 的 ROUTE_NAMES、today/index.ts 的 routes）；返回：App 里有上一页就退回，否则换到设置（S11）
import { useEffect, useState } from 'react';
import { canGoBack, goBack, replaceRoute } from '../../../app/router.ts';
import { Pressable } from '../../../motion/components.ts';
import { useTodayT } from '../hooks/useTodayT.ts';
import { useTrash, type RestoreResult } from '../hooks/useTrash.ts';
import styles from './RecentlyDeletedPage.module.css';

function back(): void {
  if (canGoBack()) goBack();
  else void replaceRoute('settings');
}

export default function RecentlyDeletedPage() {
  const t = useTodayT();
  const { items, restore } = useTrash();
  const [msg, setMsg] = useState<RestoreResult | null>(null);

  useEffect(() => {
    if (msg !== 'ok') return undefined;
    const id = setTimeout(() => setMsg(null), 2000);
    return () => clearTimeout(id);
  }, [msg]);

  return (
    <main className={styles.page} data-feature="trash" data-testid="trash">
      <header className={styles.top}>
        <Pressable className={styles.back} onClick={back} data-testid="trash-back">
          {`‹ ${t('trash.back', {})}`}
        </Pressable>
        <h1 className={styles.h1}>{t('trash.title', {})}</h1>
        <span />
      </header>
      <p className={styles.note}>{t('trash.note', {})}</p>
      {items.length === 0 ? <p className={styles.empty} data-testid="trash-empty">{t('trash.empty', {})}</p> : null}
      <ul className={styles.list}>
        {items.map((it) => (
          <li key={`${it.table}:${it.id}`} className={styles.row} data-testid={`trash-row-${it.id}`}>
            <span className={styles.main}>
              <span className={styles.title}>{it.title}</span>
              <span className={styles.sub}>
                {t(it.table === 'events' ? 'trash.kind.events' : 'trash.kind.todos', {})} · {t('trash.left', { n: it.daysLeft })}
              </span>
            </span>
            <Pressable className={styles.restore} onClick={() => void restore(it.table, it.id).then(setMsg)} data-testid={`trash-restore-${it.id}`}>
              {t('trash.restore', {})}
            </Pressable>
          </li>
        ))}
      </ul>
      {msg === 'ok' ? (
        <p className={styles.toast} role="status" data-testid="trash-msg">
          {t('trash.restored', {})}
        </p>
      ) : msg === 'failed' || msg === 'readonly' ? (
        <p className={styles.toast} role="alert" data-testid="trash-msg">
          {t(msg === 'readonly' ? 'err.readonly' : 'err.save', {})}
        </p>
      ) : null}
    </main>
  );
}
