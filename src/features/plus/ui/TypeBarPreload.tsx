// 首屏画完以后挂一份的东西（index.ts 的 TypeBarPreload，跟打字条同一块下载），不碰 App.tsx 和底栏：
// • “＋”上方的小气泡（B3 S23，PlusHint；开关关着时什么都不画）。随手记页不出（R-436 主持人 11-16 定：这页的“＋”是聚焦底部输入行，
//   气泡“按住说话 · 点一下打字”的后半句对不上）；看路由放在这块懒加载里判断，不往首屏 App / tab-of 加字节
// • 按住“＋”录音的整套界面（B3 FA-3，RecordHost）：再按需加载一块（录音器、手机识别、面板、说明卡），挂上以后才接手手势
// • 小气泡和录音那一套放在同一个 Suspense 里，等录音那一块连同它的样式（RecordHost、Dialog 两份 CSS）都到了才一起挂：
//   WebKit 在还有样式表没加载完时，新挂上的元素拿不到作者样式（气泡 position: static、占在文档流里高 19 px），
//   页面被撑高、滚动锚定把 scrollY 带走 19～58 px，样式到了气泡才变成 fixed（Q-8 e2e webkit 偶发，FA-3 时按调试日志查明：
//   “add DIV[plus-hint] pos=static h=19 pending=[Dialog-….css,RecordHost-….css]”之后紧跟“scroll 0->819”）。
//   录音那一块下载不到时（离线冷启动又没缓存）气泡也不出，是一样的提示，不影响记东西
// • 查找面板的挂载点和电脑 Ctrl+K（B4b-2，features/smart-search 的 FindHost）：单独一个 Suspense，不等录音那一块；
//   挂在这里是为了 Ctrl+K 不往首屏加字节（首屏额度只剩十几字节）
// • Ctrl+N 打字记一条（S24）：同理挂在这里（11-14 层栈整块评审：首屏 150 KB 预算差 0.2 KB，层栈的快捷键入口整个挪出首屏）。
//   这一块只在有“＋”的页挂（App 只在那些页画 PlusSlot），所以有“＋”的页才接；调 App 的 open：开着时再按只让 opened 加 1
//   （收起、只剩提示条时靠它重新展开、聚焦，独立验证 11-11）。首屏刚画完、这一块还没下载好时按 Ctrl+N 不响应（和 Ctrl+K 同一个取舍）
// 打字条本身的预先下载不在这里，见 index.ts 的 loadTypeBar 和 app/plus-slot.tsx（Q-24）
import { lazy, Suspense, useEffect } from 'react';
import { useRoute } from '../../../app/router.ts';
import { useKeys } from '../../../kit/hooks/layers.ts';
import { FindHost } from '../../smart-search/index.ts';
import { setTypeOpener } from '../hooks/assist-open.ts';
import PlusHint from './PlusHint.tsx';

const RecordHost = lazy(() => import('./RecordHost.tsx').then((m) => ({ default: m.RecordHost })));

/** onType：“改用打字”打开打字条（App 的 open，经 app/plus-slot.tsx 传进来）；也登记给结果层的“改”（hooks/assist-open.ts）
 *  hold：这一页能不能按住“＋”说话（app/tab-of.ts，隐私记页、纪念日页不能），不能时小气泡不出
 *  typing：打字条开着（app/plus-slot.tsx 的 open）。开着时小气泡不画：已经在打字，提示多余，还压在打字条右下角（R-451 主持人 11-17 定）；
 *  只是不画，不记“看过”：收起后照原规则（这次启动查过的结果，见 ../data/plus-hint.ts）再出 */
export default function TypeBarPreload({ onType, hold = true, typing = false }: { onType?: (() => void) | undefined; hold?: boolean; typing?: boolean }) {
  const onNotes = useRoute().name === 'notes';
  const hint = hold && !onNotes && !typing;
  useEffect(() => {
    setTypeOpener(onType ?? null);
    return () => setTypeOpener(null);
  }, [onType]);
  useKeys({
    'mod+n': () => {
      if (!onType) return false;
      onType();
      return true;
    },
  });
  return (
    <>
      <Suspense fallback={null}>
        <RecordHost onType={onType} />
        {hint ? <PlusHint /> : null}
      </Suspense>
      <Suspense fallback={null}>
        <FindHost />
      </Suspense>
    </>
  );
}
