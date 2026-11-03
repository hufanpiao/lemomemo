// exe 里本机会话出问题时的整屏提示（盖住整个视口，不给继续用账号界面）。两种：
// • incomplete（安全审查 A-1、代码审查 A-M1）：退出、被移除时删凭据管理器失败——“退出没完成，点重试”。
//   重试调 session.ts 的 retryDropSession（再删一次，删成了整页重新载入）；还没删掉写一句“还是没删掉”。
//   goToAuth 判失败时显示（watchExitIncomplete 订阅 session-store），启动时带着“待删除”标记又删不掉时也显示（main 入口直接挂）。
//   之后晚到的删除成功了（状态回到 ok）也自动重新载入
// • unavailable（代码审查建议 4）：installDesktopSession 没装上（分包加载失败、Rust 不在）——“读不到登录信息，请重新打开”，按钮重新载入
// 另挂一个根（同 root.tsx 的 watchCacheBlocked），不用动效；样式沿用 CacheTooNewScreen 的整屏样式。
// 挂出时给 #root 加 inert（底下的账号界面点不到、Tab 也进不去、读屏不读），焦点移到按钮上；卸掉时把 inert 还原（安全复审建议 ②）
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useT } from '../kit/hooks/useT.ts';
import { retryDropSession } from '../platform/session-drop.ts';
import { exitIncompleteShown, sessionDropState, subscribeSessionDrop } from '../platform/session-store.ts';
import { reloadPage } from '../platform/sw-register.ts';
import styles from './CacheTooNewScreen.module.css';

export type ExitScreenKind = 'incomplete' | 'unavailable';

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

/** 另挂一个根画出整屏提示（已经挂着就不再挂）；返回卸掉的函数 */
export function mountExitScreen(kind: ExitScreenKind, doc: Document = document): () => void {
  const prev = doc.querySelector('[data-exit-screen-host]');
  if (prev) return () => undefined;
  const host = doc.createElement('div');
  host.setAttribute('data-exit-screen-host', kind);
  doc.body.appendChild(host);
  // 底下的账号界面不可交互（本来就 inert 的不动、卸掉时也不去掉）
  const app = doc.getElementById('root');
  const wasInert = app?.hasAttribute('inert') ?? true;
  if (app && !wasInert) app.setAttribute('inert', '');
  const root = createRoot(host);
  root.render(<ExitIncompleteScreen kind={kind} />);
  return () => {
    root.unmount();
    host.remove();
    if (app && !wasInert) app.removeAttribute('inert');
  };
}

/**
 * 主 App 画出账号界面以后挂上（main.tsx）：goToAuth 判删除失败（showExitIncomplete）时挂出 incomplete；
 * 挂着时删除状态回到 ok（晚到的删除成功）就整页重新载入。返回退订
 */
export function watchExitIncomplete(doc: Document = document, reload: () => void = reloadPage): () => void {
  let unmount: (() => void) | null = null;
  const check = (): void => {
    if (!exitIncompleteShown()) return;
    if (!unmount) unmount = mountExitScreen('incomplete', doc);
    else if (sessionDropState() === 'ok') reload();
  };
  const off = subscribeSessionDrop(check);
  check();
  return () => {
    off();
    unmount?.();
  };
}
