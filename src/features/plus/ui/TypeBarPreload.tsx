// 首屏画完以后挂一份的东西（index.ts 的 TypeBarPreload，跟打字条同一块下载），不碰 App.tsx 和底栏：
// • “＋”上方的小气泡（B3 S23，PlusHint；开关关着时什么都不画）
// • 按住“＋”录音的整套界面（B3 FA-3，RecordHost）：再按需加载一块（录音器、手机识别、面板、说明卡），挂上以后才接手手势
// 打字条本身的预先下载不在这里，见 index.ts 的 loadTypeBar 和 app/plus-slot.tsx（Q-24）
import { lazy, Suspense } from 'react';
import PlusHint from './PlusHint.tsx';

const RecordHost = lazy(() => import('./RecordHost.tsx').then((m) => ({ default: m.RecordHost })));

/** onType：“改用打字”打开打字条（App 的 open，经 app/plus-slot.tsx 传进来） */
export default function TypeBarPreload({ onType }: { onType?: (() => void) | undefined }) {
  return (
    <>
      <PlusHint />
      <Suspense fallback={null}>
        <RecordHost onType={onType} />
      </Suspense>
    </>
  );
}
