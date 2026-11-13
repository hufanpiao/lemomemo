// 纪念日的头像（B5 S16）：取图（hooks/useAnnivAvatar）+ kit 的 AnnivAvatar 画圆。纪念日页面直接用；
// 今天页的纪念日一行经 anniv/index.ts 懒加载它（default 导出），没加载好时今天页先画首字圆
import { AnnivAvatar, type AnnivAvatarSize } from '../../../kit/components/AnnivAvatar.tsx';
import { useAnnivAvatar } from '../hooks/useAnnivAvatar.ts';

export interface AnnivFaceProps {
  id: string;
  avatarId: unknown;
  name: string;
  kind: unknown;
  size: AnnivAvatarSize;
}

export function AnnivFace({ id, avatarId, name, kind, size }: AnnivFaceProps) {
  const url = useAnnivAvatar(id, avatarId);
  return <AnnivAvatar url={url} name={name} kind={kind} size={size} />;
}

export default AnnivFace;
