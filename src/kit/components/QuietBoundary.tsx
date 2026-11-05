// 页面里嵌着的、可有可无的一小块（比如今天页、待办页上提醒功能懒加载的“错过的提醒”“未同步”提示和行尾标记）出错时只把这一块去掉，
// 不往上抛、不把整页换成出错页。最常见的是离线时这一块的分包下不来（SW 没缓存到）——提醒引擎这时多半也挂不上（今天页待办 代码审查 M1）。
// 日志（代码复审 N1）：出错时按 name 记一条，由入口（app/main.tsx）用 setQuietErrorLog 接上日志通道（kit 不碰日志层）；没接时不记。
// name 要短：入口拼成动作名 quiet_error_<name>，logs.act 最长 32 个字符（name 不超过 20）。只交 name 和错误对象，入口只记“错误类型@文件名:行号”，不带用户内容；同一个 name 这一页只记一次（行尾标记每行一个，出错时不刷屏）
import { Component, type ErrorInfo, type ReactNode } from 'react';

let onQuietError: ((name: string, error: unknown) => void) | null = null;
const logged = new Set<string>();
/** name 的约定：小写字母、数字、连字符，1～20 个（代码复审第三轮 L5）；不合规的按 'bad-name' 记，动作名不会超长 */
export const QUIET_NAME = /^[a-z0-9-]{1,20}$/;

/** 入口接日志：name 是哪一块（比如 'missed'、'unsynced-hint'、'unsynced-mark'、'missed-sheet'） */
export function setQuietErrorLog(fn: ((name: string, error: unknown) => void) | null): void {
  onQuietError = fn;
}

/** 测试用：清掉“这一页记过的 name” */
export function resetQuietErrorLogForTest(): void {
  logged.clear();
}

interface State {
  failed: boolean;
}

export class QuietBoundary extends Component<{ children: ReactNode; name: string }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    const name = QUIET_NAME.test(this.props.name) ? this.props.name : 'bad-name';
    if (logged.has(name)) return;
    logged.add(name);
    try {
      onQuietError?.(name, error);
    } catch {
      // 日志出错不挡页面
    }
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
