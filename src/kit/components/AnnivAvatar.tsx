// 纪念日头像的圆（B5 S16；R-117、R-121；皮肤视觉稿 anniv / annface）：只画，不取图——图的 blob: 地址由纪念日功能取好传进来（anniv 的 AnnivFace）
// • 有地址：圆形图片（<img> 只经 useBlobSrc 设 src）
// • 没头像、还在取、取不到（url 为 null）：名字第一个字（按字素切，kit 的 nameInitial）加类型颜色的圆——生日 --p1、纪念日 --p3、倒数日 --p2，字 --on-p
// • 装饰性：alt 为空、aria-hidden（名字就在旁边，读屏不重复）
import { nameInitial } from '../hooks/useMeInitial.ts';
import { useBlobSrc } from '../hooks/useBlobSrc.ts';
import styles from './AnnivAvatar.module.css';

export type AnnivAvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const TONE: Readonly<Record<string, string | undefined>> = { birthday: styles.p1, anniversary: styles.p3, countdown: styles.p2 };

function Img({ url }: { url: string }) {
  const ref = useBlobSrc(url);
  return <img ref={ref} className={styles.img} alt="" />;
}

export function AnnivAvatar({ url, name, kind, size }: { url: string | null; name: string; kind: unknown; size: AnnivAvatarSize }) {
  const tone = (typeof kind === 'string' ? TONE[kind] : undefined) ?? styles.p1;
  return (
    <span className={`${styles.av} ${styles[size]} ${url ? '' : tone}`} aria-hidden="true" data-testid="anniv-avatar" data-has-img={url ? '' : undefined}>
      {url ? <Img url={url} /> : nameInitial(name) ?? ''}
    </span>
  );
}
