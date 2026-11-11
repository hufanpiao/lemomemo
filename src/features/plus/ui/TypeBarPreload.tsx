// “＋”上方的小气泡（B3 S23，PlusHint；开关关着时什么都不画）：App 首屏画完以后挂一份（index.ts 的 TypeBarPreload），不碰 App.tsx 和底栏。
// 打字条本身的预先下载不在这里，见 index.ts 的 loadTypeBar 和 app/plus-slot.tsx（Q-24）
import PlusHint from './PlusHint.tsx';

export default function TypeBarPreload() {
  return <PlusHint />;
}
