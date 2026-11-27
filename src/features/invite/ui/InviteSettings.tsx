// 设置页里用到的这一块（invite/index.ts 只导出这一个懒加载组件）：“邀请朋友”二级页正文。
// 首页那一行由设置页画，画不画看 ai-provider 的管理员标志（AiProviderSettings part="adminOnly"，ai-provider 函数 mine 回 admin: true，
// 和 invite-admin 同一个查法：_shared/user-reads.ts 的 isAdmin 查 private.admins）
import { InvitePage } from './InvitePage.tsx';

export default function InviteSettings() {
  return <InvitePage />;
}
