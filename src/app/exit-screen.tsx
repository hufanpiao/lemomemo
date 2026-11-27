// exe 里本机会话出问题时的整屏提示的挂载和订阅；组件本体（ExitIncompleteScreen.tsx）只在真要挂出时才下载。
// • 挂出时马上建好宿主、#root 同步 inert（底下的账号界面立刻点不到，不等下载），下载好再画组件
// • 下载失败：画首屏里已有的静态兜底 AppCrashFallback（刷新即重新载入），不留一层空白挡住页面
// • 下载期间就卸掉：下载好也不再画
import { createRoot, type Root } from 'react-dom/client';
import { exitIncompleteShown, sessionDropState, subscribeSessionDrop } from '../platform/session-store.ts';
import { reloadPage } from '../platform/sw-register.ts';
import { AppCrashFallback } from './AppCrashFallback.tsx';
import type { ExitIncompleteScreen } from './ExitIncompleteScreen.tsx';

export type ExitScreenKind = 'incomplete' | 'unavailable';

/** 层栈不在首屏，按需下载 */
const loadLayers = () => import('../kit/hooks/layers.ts');

type ScreenModule = { ExitIncompleteScreen: typeof ExitIncompleteScreen };
const loadScreen = (): Promise<ScreenModule> => import('./ExitIncompleteScreen.tsx');

/** 另挂一个根画出整屏提示（已经挂着就不再挂）；返回卸掉的函数。load 只给测试换 */
export function mountExitScreen(kind: ExitScreenKind, doc: Document = document, load: () => Promise<ScreenModule> = loadScreen): () => void {
  const prev = doc.querySelector('[data-exit-screen-host]');
  if (prev) return () => undefined;
  const host = doc.createElement('div');
  host.setAttribute('data-exit-screen-host', kind);
  doc.body.appendChild(host);
  // 整屏提示是层栈（kit/hooks/layers.ts）里的模态层：Esc 只拦下不关，焦点由组件放到按钮上。层栈不在首屏，下载到了才入栈；
  // 所以 #root 在挂出时当场同步 inert：层栈下载慢或失败时，底下的账号界面也点不到、Tab 走不到。
  // 本来就 inert 的不动，卸掉时只撤这里自己加的
  const app = doc.getElementById('root');
  const wasInert = app?.hasAttribute('inert') ?? true;
  if (app && !wasInert) app.setAttribute('inert', '');
  let root: Root | null = null;
  let gone = false;
  let pop: (() => void) | null = null;
  loadLayers().then(
    (m) => {
      if (!gone) pop = m.pushLayer(() => ({ name: 'exit-screen', modal: true, el: () => host, back: () => [] })).pop;
    },
    () => undefined,
  );
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
    pop?.();
    if (app && !wasInert) app.removeAttribute('inert');
    host.remove();
  };
}

/**
 * 主 App 画出账号界面以后挂上（main.tsx）：goToAuth 判删除失败（showExitIncomplete）时挂出 incomplete；
 * 挂着时删除状态回到 ok（晚到的删除成功）就整页重新载入。返回退订
 */
export function watchExitIncomplete(doc: Document = document, reload: () => void = reloadPage): () => void {
  loadLayers().catch(() => undefined);
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
