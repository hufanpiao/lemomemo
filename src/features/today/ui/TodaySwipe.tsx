// 今天页待办行的左滑删除（负责人 11-15“代办后面的x去掉”，R-428）：kit 的 SwipeRow 原样包一层，好让功能入口 index.ts 按需下载它
// （首屏画完以后才下载，连着 useHDrag、层栈约 5 KB，放进首屏会超 150 KB 预算；index.ts 只许 lazy 本功能里的文件，不许直接引 kit）
import { SwipeRow, type SwipeRowProps } from '../../../kit/components/SwipeRow.tsx';

export default function TodaySwipe(p: SwipeRowProps) {
  return <SwipeRow {...p} />;
}
