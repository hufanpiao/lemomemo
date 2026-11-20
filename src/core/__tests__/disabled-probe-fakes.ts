// 测试用：按“想要的结论”造一个探测结果（core/account-leave.ts 的闸吃的是 platform/account-status.ts 的 AccountProbe）
import type { AccountProbe, ProbedExit } from '../../platform/account-status.ts';

/** removed → signed_out；unknown → 探测不出（按 disabled 只退出） */
export function probeOf(v: Exclude<ProbedExit, 'disabled_unsure' | 'deletion_unsure'> | 'active' | 'unknown'): AccountProbe {
  switch (v) {
    case 'removed':
      return { kind: 'signed_out' };
    case 'pending_deletion':
      return { kind: 'pending_deletion', purgeAfter: null };
    case 'disabled':
      return { kind: 'disabled' };
    case 'active':
      return { kind: 'active' };
    default:
      return { kind: 'unknown' };
  }
}
