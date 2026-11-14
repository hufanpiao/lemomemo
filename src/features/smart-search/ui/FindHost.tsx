// 查找面板的挂载点和电脑 Ctrl+K（B4b-2；架构 5.14 第 1 点“窗口内 Ctrl+K 打开同一个输入框”、线框 s12 电脑版）
// • features/plus 的 TypeBarPreload 首屏画完以后挂一份（和“＋”上方小气泡、按住录音那一套一起），所以 Ctrl+K 不往首屏加任何字节；
//   首屏刚画完、这一块还没下载好时按 Ctrl+K 不响应（和按住“＋”在下载好之前只当点一下同一个取舍）
// • 隐私记页不接 Ctrl+K（D-16：隐私记页面里只查隐私记，这一批不做隐私记查找），打开着的面板照常
// • 面板本身再按需下载一块（FindPanel），第一次打开才下载；面板按 openFind 的序号重新挂载
import { lazy, Suspense, useSyncExternalStore } from 'react';
import { useRoute } from '../../../app/router.ts';
import { useKeys } from '../../../kit/hooks/useKeys.ts';
import { closeFind, findOpenSnapshot, openFind, subscribeFindOpen } from '../hooks/find-open.ts';

const FindPanel = lazy(() => import('./FindPanel.tsx'));

export default function FindHost() {
  const cur = useSyncExternalStore(subscribeFindOpen, findOpenSnapshot, findOpenSnapshot);
  const route = useRoute();
  useKeys({
    'mod+k': () => {
      if (route.name === 'vault') return false;
      openFind('', 'ctrlk');
      return true;
    },
  });
  if (cur === null) return null;
  return (
    <Suspense fallback={null}>
      <FindPanel key={cur.n} query={cur.q} from={cur.from} onClose={closeFind} />
    </Suspense>
  );
}
