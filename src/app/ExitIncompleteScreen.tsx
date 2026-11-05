// exe 里本机会话出问题时的整屏提示（盖住整个视口，不给继续用账号界面）。两种：
// • incomplete（安全审查 A-1、代码审查 A-M1）：退出、被移除时删凭据管理器失败——“退出没完成，点重试”。
//   重试调 session.ts 的 retryDropSession（再删一次，删成了整页重新载入）；还没删掉写一句“还是没删掉”。
//   goToAuth 判失败时显示（watchExitIncomplete 订阅 session-store），启动时带着“待删除”标记又删不掉时也显示（main 入口直接挂）。
//   之后晚到的删除成功了（状态回到 ok）也自动重新载入
// • unavailable（代码审查建议 4）：installDesktopSession 没装上（分包加载失败、Rust 不在）——“读不到登录信息，请重新打开”，按钮重新载入
// 另挂一个根（同 root.tsx 的 watchCacheBlocked），不用动效；样式沿用 CacheTooNewScreen 的整屏样式。
// 挂出时给 #root 加 inert（底下的账号界面点不到、Tab 也进不去、读屏不读），焦点移到按钮上；卸掉时把 inert 还原（安全复审建议 ②）
// 挂载、订阅（mountExitScreen、watchExitIncomplete）在 exit-screen.tsx，本文件只有组件、按需下载（11-05 首屏瘦身，主持人定第 4 项）
import { useEffect, useRef, useState } from 'react';
import { useT } from '../kit/hooks/useT.ts';
import { retryDropSession } from '../platform/session-drop.ts';
import { reloadPage } from '../platform/sw-register.ts';
import styles from './CacheTooNewScreen.module.css';

import type { ExitScreenKind } from './exit-screen.tsx';

export type { ExitScreenKind };

export function ExitIncompleteScreen({ kind, retry = retryDropSession, reload = reloadPage }: {
  kind: ExitScreenKind;
  retry?: () => Promise<boolean>;
  reload?: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inc = kind === 'incomplete';
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    button.current?.focus();
  }, []);
  const onClick = (): void => {
    if (!inc) {
      reload();
      return;
    }
    if (busy) return;
    setBusy(true);
    setFailed(false);
    void retry()
      .catch(() => false)
      .then((ok) => {
        setBusy(false);
        setFailed(!ok);
      });
  };
  return (
    <div
      className={styles.screen}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="exit-screen-title"
      aria-describedby="exit-screen-body"
      data-testid="exit-screen"
      data-kind={kind}
    >
      <div className={styles.card}>
        <h1 id="exit-screen-title" className={styles.title}>
          {t(inc ? 'exit.incomplete.title' : 'exit.unavailable.title', {})}
        </h1>
        <p id="exit-screen-body" className={styles.body}>
          {t(inc ? 'exit.incomplete.body' : 'exit.unavailable.body', {})}
        </p>
        <div className={styles.actions}>
          <button ref={button} type="button" className={styles.primary} aria-disabled={busy} onClick={onClick} data-testid="exit-screen-action">
            {inc ? (busy ? t('exit.incomplete.busy', {}) : t('exit.incomplete.retry', {})) : t('exit.unavailable.reopen', {})}
          </button>
        </div>
        <p className={styles.status} role="status">
          {failed ? t('exit.incomplete.failed', {}) : ''}
        </p>
      </div>
    </div>
  );
}
