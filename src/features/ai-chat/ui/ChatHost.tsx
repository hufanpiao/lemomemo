// AI 助手的挂载点（照 smart-search 的 FindHost）：features/plus 的 TypeBarPreload 首屏画完以后挂一份
// • 网页版宽屏（kit useMedia 的 MQ_DESK_WIDE）、路由表 LEVELS 定了常驻栏的页（app/router-levels.ts 的 dockOf）：画右边常驻栏 ChatDock，
//   “＋”点“问 AI”交来的一句也交给它，不开半屏；在这些页之间切换时常驻栏在同一个位置，不重挂
// • 别的宽度、别的页：照旧是半屏抽屉 ChatDrawer，第一次打开才下载
// • 两个都是懒加载，手机宽度不下载常驻栏
import { lazy, Suspense, useSyncExternalStore } from 'react';
import { useRoute } from '../../../app/router.ts';
import { dockOf } from '../../../app/router-levels.ts';
import { MQ_DESK_WIDE, useMedia } from '../../../kit/hooks/useMedia.ts';
import { chatOpenSnapshot, closeChat, subscribeChatOpen } from '../hooks/chat-open.ts';

const ChatDrawer = lazy(() => import('./ChatDrawer.tsx'));
const ChatDock = lazy(() => import('./ChatDock.tsx'));

export default function ChatHost() {
  const cur = useSyncExternalStore(subscribeChatOpen, chatOpenSnapshot, chatOpenSnapshot);
  const wide = useMedia(MQ_DESK_WIDE);
  const r = useRoute();
  const dock = wide ? dockOf(r.name, r.params[0]) : undefined;
  if (dock === undefined && cur === null) return null;
  return (
    <Suspense fallback={null}>
      {dock !== undefined ? <ChatDock open={cur} page={dock} /> : cur !== null ? <ChatDrawer key={cur.n} open={cur} onClose={closeChat} /> : null}
    </Suspense>
  );
}
