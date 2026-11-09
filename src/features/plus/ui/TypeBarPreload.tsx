// 预先下载打字条（B3 Q4）：App 首屏画完以后挂一份（index.ts 的 TypeBarPreload），只为把 TypeBar 那一块下载进内存，什么都不画。
// 留住 TypeBar 的引用：这一块是动态入口，导出的东西打包时不会被摇掉，TypeBar 的代码一定跟着下载
import TypeBar from './TypeBar.tsx';

export const typeBar = TypeBar;

export default function TypeBarPreload() {
  return null;
}
