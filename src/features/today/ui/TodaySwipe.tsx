// 今天页待办行的左滑删除：kit 的 DelSwipe（待办页同一份）填上今天页的测试 id 前缀和运行日志。
// 单独成文件、经功能入口 index.ts 的 loadTodaySwipe 按需下载（首屏画完以后才下载，连着 useHDrag、层栈约 5 KB）：import() 写在主包里，
// 主包的预加载表不给首屏以外的目标列 JS；写在今天页那一块时表里要列 SwipeRow 整个闭包，首屏会超预算（e2e b2-first-screen-budget）
import { DelSwipe, type DelSwipeProps } from '../../../kit/components/SwipeRow.tsx';
import { rlog } from '../../../platform/run-log-api.ts';

export type TodaySwipeProps = Omit<DelSwipeProps, 'tid' | 'log'>;

export default function TodaySwipe(p: TodaySwipeProps) {
  return <DelSwipe tid="today" log={rlog} {...p} />;
}
