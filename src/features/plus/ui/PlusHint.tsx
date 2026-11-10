// “＋”上方的小气泡“按住说话 · 点一下打字”（B3 S23；定稿线框“第一次使用”的 .hint：深色圆角气泡、下沿小三角指着“＋”）
// 由 TypeBarPreload 挂（首屏画完以后），不碰 App.tsx 和底栏；不挡点按（pointer-events: none）；
// role="note" 只标明这是一段旁注：出现时读屏不会自动播报，读屏用户逐项浏览到它时才会读出来（S23 代码审建议 4）
// 开关、次数、位置见 ../hooks/usePlusHint.ts
import { usePlusHint } from '../hooks/usePlusHint.ts';
import { usePlusT } from '../hooks/usePlusT.ts';
import styles from './TypeBar.module.css';

export default function PlusHint({ enabled, exe }: { enabled?: boolean; exe?: boolean }) {
  const t = usePlusT();
  const spot = usePlusHint(enabled, exe);
  if (spot === null) return null;
  return (
    <div
      className={styles.hint}
      // 旁注：不自动播报，浏览到才读（见文件头）
      role="note"
      data-testid="plus-hint"
      // 位置跟着“＋”量出来，只能写在元素上（两个数，不是颜色、不是动画）
      style={{ right: spot.right, bottom: spot.bottom }}
    >
      {t('plus.hint.bubble', {})}
    </div>
  );
}
