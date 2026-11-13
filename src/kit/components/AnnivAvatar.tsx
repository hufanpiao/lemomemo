// 纪念日头像（B5 S16；R-117、R-121；皮肤视觉稿 anniv / annface）：今天页、纪念日列表和大卡、编辑页共用
// • 有头像（avatar_id）：圆形图片（经 useAnnivAvatar 取 blob: 地址，<img> 只经 useBlobSrc 设 src）
// • 没头像、还在取、取不到：名字第一个字（按字素切，kit 的 nameInitial）加类型颜色的圆——生日 --p1、纪念日 --p3、倒数日 --p2，字 --on-p
// • 装饰性：alt 为空、aria-hidden（名字就在旁边，读屏不重复）
import { nameInitial } from '../hooks/useMeInitial.ts';
import { useAnnivAvatar } from '../hooks/useAnnivAvatar.ts';
import { useBlobSrc } from '../hooks/useBlobSrc.ts';
import styles from './AnnivAvatar.module.css';

export type AnnivAvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const TONE: Readonly<Record<string, string | undefined>> = { birthday: styles.p1, anniversary: styles.p3, countdown: styles.p2 };

function Img({ url }: { url: string }) {
  const ref = useBlobSrc(url);
  return <img ref={ref} className={styles.img} alt="" />;
}

export function AnnivAvatar({ id, avatarId, name, kind, size }: { id: string; avatarId: unknown; name: string; kind: unknown; size: AnnivAvatarSize }) {
  const url = useAnnivAvatar(id, avatarId);
  const tone = (typeof kind === 'string' ? TONE[kind] : undefined) ?? styles.p1;
  return (
    <span className={`${styles.av} ${styles[size]} ${url ? '' : tone}`} aria-hidden="true" data-testid="anniv-avatar" data-has-img={url ? '' : undefined}>
      {url ? <Img url={url} /> : nameInitial(name) ?? ''}
    </span>
  );
}
