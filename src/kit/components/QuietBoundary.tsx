// 页面里嵌着的、可有可无的一小块（比如今天页、待办页上提醒功能懒加载的“错过的提醒”“未同步”提示和行尾标记）出错时只把这一块去掉，
// 不往上抛、不把整页换成出错页。最常见的是离线时这一块的分包下不来（SW 没缓存到）——提醒引擎这时多半也挂不上（今天页待办 代码审查 M1）。
// 日志（代码复审 N1）：出错时按 name 记一条进日志总线（shared/core/log-bus.ts），动作名 quiet_error_<name>，logs.act 最长 32 个字符（name 不超过 20）。
// 只交错误对象，入口只记“错误类型@文件名:行号”，不带用户内容；同一个 name 这一页只记一次（行尾标记每行一个，出错时不刷屏）
// Later（文件末尾）：按需下载的一小块的统一包装（QuietBoundary + Suspense；独立评审 11-18 二-3，今天页、待办页原来每处各抄一份）。
// 放在这个文件里、不单独一个文件：单独一个文件会被今天页、待办页各自引到而拆成一个小块，首屏多一个文件（e2e b2-first-screen-budget 超 150 KB）
import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { logEvent } from '../../../shared/core/log-bus.ts';
import { usePainted } from '../hooks/usePainted.ts';

const logged = new Set<string>();
/** name 的约定：小写字母、数字、连字符，1～20 个（代码复审第三轮 L5）；不合规的按 'bad-name' 记，动作名不会超长 */
export const QUIET_NAME = /^[a-z0-9-]{1,20}$/;

/** 测试用：清掉“这一页记过的 name” */
export function resetQuietErrorLogForTest(): void {
  logged.clear();
}

interface State {
  failed: boolean;
}

/** fallback：出错时画它（不给就什么都不画；电脑版布局分包下不来时今天页、随手记页退回一列的画法）；onFail：出错时告诉页面（今天页据它把点行改回进编辑页） */
export class QuietBoundary extends Component<{ children: ReactNode; name: string; fallback?: ReactNode; onFail?: () => void }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.onFail?.();
    const name = QUIET_NAME.test(this.props.name) ? this.props.name : 'bad-name';
    if (logged.has(name)) return;
    logged.add(name);
    logEvent(`quiet_error_${name}`, { error });
  }

  override render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

/**
 * 页面里按需下载的一小块（lazy 组件）：下载中、分包下不来（离线、SW 没缓存到）时画 fallback（默认什么都不画），不把整页换成出错页
 * • name：出错时记日志 quiet_error_<name>（同上，小写字母、数字、连字符，1～20 个）
 * • fallback：下载中和出错时都画它（今天页只读方框：没下载好、下不来都先画普通方框）
 * • afterPaint：首屏画完以后才挂、才下载（kit/hooks/usePainted.ts），不算进首屏预算；画完以前什么都不画（不画 fallback）
 * • onFail：出错时告诉页面（同 QuietBoundary）
 */
export function Later({ name, children, fallback = null, afterPaint = false, onFail }: { name: string; children: ReactNode; fallback?: ReactNode; afterPaint?: boolean; onFail?: () => void }) {
  const painted = usePainted();
  if (afterPaint && !painted) return null;
  return (
    <QuietBoundary name={name} fallback={fallback} {...(onFail ? { onFail } : {})}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </QuietBoundary>
  );
}
