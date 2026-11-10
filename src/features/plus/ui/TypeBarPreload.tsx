// 预先下载打字条（B3 Q4）：App 首屏画完以后挂一份（index.ts 的 TypeBarPreload），只为把 TypeBar 那一块下载进内存，什么都不画。
// 留住 TypeBar 的引用：这一块是动态入口，导出的东西打包时不会被摇掉，TypeBar 的代码一定跟着下载
// 也顺带挂“＋”上方的小气泡（B3 S23，PlusHint；开关关着时什么都不画）：首屏画完以后才挂，不碰 App.tsx 和底栏
import PlusHint from './PlusHint.tsx';
import TypeBar from './TypeBar.tsx';

export const typeBar = TypeBar;

export default function TypeBarPreload() {
  return <PlusHint />;
}
