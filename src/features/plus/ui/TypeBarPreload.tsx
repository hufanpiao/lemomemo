// 首屏画完以后挂一份的东西（index.ts 的 TypeBarPreload，跟打字条同一块下载），不碰 App.tsx 和底栏：
// • “＋”上方的小气泡（PlusHint；开关关着时什么都不画）。随手记页不出（这页的“＋”是聚焦底部输入行，
//   气泡“按住说话 · 点一下打字”的后半句对不上）；看路由放在这块懒加载里判断，不往首屏 App / tab-of 加字节
// • 按住“＋”录音的整套界面（RecordHost）：再按需加载一块（录音器、面板、说明卡），挂上以后才接手手势
// • 小气泡和录音那一套放在同一个 Suspense 里，等录音那一块连同它的样式（RecordHost、Dialog 两份 CSS）都到了才一起挂：
//   WebKit 在还有样式表没加载完时，新挂上的元素拿不到作者样式（气泡 position: static、占在文档流里高 19 px），
//   页面被撑高、滚动锚定把 scrollY 带走 19～58 px，样式到了气泡才变成 fixed（调试日志：
//   “add DIV[plus-hint] pos=static h=19 pending=[Dialog-….css,RecordHost-….css]”之后紧跟“scroll 0->819”）。
//   录音那一块下载不到时（离线冷启动又没缓存）气泡也不出，是一样的提示，不影响记东西
// • 查找面板的挂载点和电脑 Ctrl+K（features/smart-search 的 FindHost）：单独一个 Suspense，不等录音那一块；
//   挂在这里是为了 Ctrl+K 不往首屏加字节（首屏额度只剩十几字节）
// • AI 助手抽屉的挂载点（features/ai-chat 的 ChatHost）：同 FindHost，单独一个 Suspense；抽屉本身第一次点“问 AI”才下载
// • Ctrl+N 打字记一条：同理挂在这里（首屏 150 KB 预算不够，层栈的快捷键入口整个放在首屏外）。
//   这一块只在有“＋”的页挂（App 只在那些页画 PlusSlot），所以有“＋”的页才接；调 App 的 open（收起了就是卸掉，再按重新挂上、聚焦）。
//   首屏刚画完、这一块还没下载好时按 Ctrl+N 不响应（和 Ctrl+K 同一个取舍）
// • 打字条记下以后的“已记下 · 撤销”提示条（ui/TypeNotice.tsx）：挂在这里不跟着打字条卸，打字条收起后照常满 8 秒、仍可撤销；
//   提示条出着时小气泡也不画（和打字条开着时一样）
// • 今天页吉祥物（features/mascot 的 MascotHost）：这一块一加载就开始下载它，下好直接画，不走 lazy + Suspense——
//   React 19 的 Suspense 显示有 300ms 节流（fallback 出过以后 300ms 内不放出内容），lazy 会让吉祥物比页面晚出约 0.3 秒；
//   运行库和素材照旧显示时才下载
// 打字条本身的预先下载不在这里，见 index.ts 的 loadTypeBar 和 app/plus-slot.tsx
import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { useRoute } from '../../../app/router.ts';
import { useKeys } from '../../../kit/hooks/layers.ts';
import { ChatHost } from '../../ai-chat/index.ts';
import { loadMascotHost, MascotPeek } from '../../mascot/index.ts';
import { FindHost } from '../../smart-search/index.ts';
import { setTypeOpener } from '../hooks/assist-open.ts';
import { useTypeNoticeOn } from '../hooks/useTypeBar.ts';
import PlusHint from './PlusHint.tsx';
import { TypeNotice } from './TypeNotice.tsx';

/** 录音那一块（录音器、面板；voice-main.ts 加载时给 AI 助手登记确认卡片的拆和存）。AI 助手抽屉打开时还没登记也经它加载（ai-chat 的 hooks/chat-open.ts） */
export const loadRecordHost = () => import('./RecordHost.tsx');

const RecordHost = lazy(() => loadRecordHost().then((m) => ({ default: m.RecordHost })));

/** 吉祥物那一块：这个模块一执行就开始下载（文件头）；下载失败这次就不出吉祥物，不报错 */
let Mascot: ComponentType | null = null;
const mascotReady = loadMascotHost().then(
  (m) => {
    Mascot = m.default;
  },
  () => undefined,
);

function MascotSlot() {
  const [M, setM] = useState(() => Mascot);
  useEffect(() => {
    if (!M) void mascotReady.then(() => setM(() => Mascot));
  }, [M]);
  return M ? <M /> : null;
}

/** onType：“改用打字”打开打字条（App 的 open，经 app/plus-slot.tsx 传进来）；也登记给结果层的“改”（hooks/assist-open.ts）
 *  hold：这一页能不能按住“＋”说话（app/tab-of.ts，隐私记页、纪念日页不能），不能时小气泡不出
 *  typing：打字条开着（app/plus-slot.tsx 的 open）。开着时小气泡不画：已经在打字，提示多余，还压在打字条右下角；
 *  只是不画，不记“看过”：收起后照原规则（这次启动查过的结果，见 ../data/plus-hint.ts）再出 */
export default function TypeBarPreload({ onType, hold = true, typing = false }: { onType?: (() => void) | undefined; hold?: boolean; typing?: boolean }) {
  const onNotes = useRoute().name === 'notes';
  const noticeOn = useTypeNoticeOn();
  const hint = hold && !onNotes && !typing && !noticeOn;
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
      <TypeNotice />
      <Suspense fallback={null}>
        <RecordHost onType={onType} />
        {hint ? <PlusHint /> : null}
      </Suspense>
      <Suspense fallback={null}>
        <FindHost />
      </Suspense>
      <Suspense fallback={null}>
        <ChatHost />
      </Suspense>
      <MascotSlot />
      {/* 输入框小人提前走完懒加载，第一次点“＋”键盘弹出前就挂好（不然冷启动第一次光标位置不对） */}
      <Suspense fallback={null}>
        <MascotPeek kind="warm" />
      </Suspense>
    </>
  );
}
