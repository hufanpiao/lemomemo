// exe 里本机会话出问题时的整屏提示的挂载和订阅（从 ExitIncompleteScreen.tsx 拆出，11-05 首屏瘦身，主持人定第 4 项）：
// 组件本体（ExitIncompleteScreen.tsx，约 0.8 KB gzip）只在真要挂出时才下载，首屏只带这里的挂载、订阅。
// • 挂出时马上建好宿主、给 #root 加 inert（底下的账号界面立刻点不到，不等下载；安全复审建议 ②），下载好再画组件；
// • 下载失败（分包坏了、取不到）：画已经在首屏里的静态兜底 AppCrashFallback（“哎呀，卡住了 · 刷新一下”，刷新即重新载入），
//   不留一层空白挡住页面。按钮文案和“退出没完成，点重试”不同，只在“整屏提示本该出现 + 它的分包又取不到”同时发生时出现；
// • 下载期间就卸掉（晚到的删除成功等）：下载好也不再画。
import { createRoot, type Root } from 'react-dom/client';
import { exitIncompleteShown, sessionDropState, subscribeSessionDrop } from '../platform/session-store.ts';
import { reloadPage } from '../platform/sw-register.ts';
import { AppCrashFallback } from './AppCrashFallback.tsx';
import type { ExitIncompleteScreen } from './ExitIncompleteScreen.tsx';

export type ExitScreenKind = 'incomplete' | 'unavailable';

type ScreenModule = { ExitIncompleteScreen: typeof ExitIncompleteScreen };
const loadScreen = (): Promise<ScreenModule> => import('./ExitIncompleteScreen.tsx');

/** 另挂一个根画出整屏提示（已经挂着就不再挂）；返回卸掉的函数。load 只给测试换 */
export function mountExitScreen(kind: ExitScreenKind, doc: Document = document, load: () => Promise<ScreenModule> = loadScreen): () => void {
  const prev = doc.querySelector('[data-exit-screen-host]');
  if (prev) return () => undefined;
  const host = doc.createElement('div');
  host.setAttribute('data-exit-screen-host', kind);
  doc.body.appendChild(host);
  // 底下的账号界面不可交互（本来就 inert 的不动、卸掉时也不去掉）
  const app = doc.getElementById('root');
  const wasInert = app?.hasAttribute('inert') ?? true;
  if (app && !wasInert) app.setAttribute('inert', '');
  let root: Root | null = null;
  let gone = false;
  void load().then(
    ({ ExitIncompleteScreen: Screen }) => {
      if (gone) return;
      root = createRoot(host);
      root.render(<Screen kind={kind} />);
    },
    () => {
      if (gone) return;
      root = createRoot(host);
      root.render(<AppCrashFallback onRefresh={reloadPage} />);
    },
  );
  return () => {
    gone = true;
    root?.unmount();
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
