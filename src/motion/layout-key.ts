// 列表“什么时候才量位置”：门面 ./AppearList.tsx 和动画实现 ./list-impl.tsx 共用这一个 context，只依赖 react，进首屏。
// 默认（undefined）：照 Motion 默认，列表项每次重画都量一遍位置；同一个 LayoutGroup 里一项量了全组都量（motion-dom 的 nodeGroup），
// 今天页 200 行时整页重画一次就要量 200 行，勾一条有七八次重画。
// 最外层 <AppearList layoutKey={对象}> 打开以后，里面所有列表（含嵌套的）的项只在这个对象换了、自己的 layoutKey 变了、进场离场时才量
// （Motion 的 layoutDependency）。页面负责在“可能挪位置”的数据变了时换一个新对象（今天页：useMemo(() => ({}), [列表数据…])）
import { createContext } from 'react';

export const LayoutKeyCtx = createContext<object | undefined>(undefined);
