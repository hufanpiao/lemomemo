// 纪念日头像的圆：只画，不取图——图的 blob: 地址由纪念日功能取好传进来（anniv 的 AnnivFace）
// • 有地址：圆形图片（<img> 只经 useBlobSrc 设 src）
// • 没头像、还在取、取不到（url 为 null）：名字第一个字（按字素切，kit 的 nameInitial）加类型颜色的圆——生日 --p1、纪念日 --p3、倒数日 --p2，字 --on-p
// • 装饰性：alt 为空、aria-hidden（名字就在旁边，读屏不重复）
import { Suspense, type ComponentType } from 'react';
import { nameInitial } from '../hooks/useMeInitial.ts';
import { QuietBoundary } from './QuietBoundary.tsx';
import { useBlobSrc } from '../hooks/useBlobSrc.ts';
import styles from './AnnivAvatar.module.css';

/** x60、x92：网页版宽屏纪念日页的小卡、大卡 */
export type AnnivAvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'x60' | 'x92';

const TONE: Readonly<Record<string, string | undefined>> = { birthday: styles.p1, anniversary: styles.p3, countdown: styles.p2 };
/** 浅色底（soft）：生日浅粉、纪念日浅黄、倒数日浅蓝，取设计系统现成的浅底令牌，字是正文色 */
const SOFT: Readonly<Record<string, string | undefined>> = { birthday: styles.s1, anniversary: styles.s2, countdown: styles.s3 };

function Img({ url }: { url: string }) {
  const ref = useBlobSrc(url);
  return <img ref={ref} className={styles.img} alt="" />;
}

/** 取图的那一份（纪念日功能的 AnnivFace，经 anniv/index.ts 懒加载）收的参数 */
export interface AnnivFaceProps {
  id: string;
  avatarId: unknown;
  name: string;
  kind: unknown;
  size: AnnivAvatarSize;
  /** 没头像时用浅色底（见 SOFT） */
  soft?: boolean | undefined;
}

/**
 * 别的功能里的纪念日头像（今天页的纪念日一行、提醒列表）：有 avatar_id 才挂 Face（懒加载、取图），没加载好、分包下不来时先画首字圆；
 * 没头像直接画首字圆。kit 不引功能，Face 由调用方从 anniv/index.ts 传进来
 */
export function AnnivAvatarSlot({ Face, ...p }: AnnivFaceProps & { Face: ComponentType<AnnivFaceProps> }) {
  const plain = <AnnivAvatar url={null} name={p.name} kind={p.kind} size={p.size} />;
  if (!p.avatarId) return plain;
  return (
    <QuietBoundary name="anniv-face">
      <Suspense fallback={plain}>
        <Face {...p} />
      </Suspense>
    </QuietBoundary>
  );
}

export function AnnivAvatar({ url, name, kind, size, soft }: { url: string | null; name: string; kind: unknown; size: AnnivAvatarSize; soft?: boolean | undefined }) {
  const k = typeof kind === 'string' ? kind : '';
  const tone = (soft ? SOFT[k] ?? styles.s1 : TONE[k] ?? styles.p1);
  return (
    <span className={`${styles.av} ${styles[size]} ${url ? '' : tone}`} aria-hidden="true" data-testid="anniv-avatar" data-has-img={url ? '' : undefined}>
      {url ? <Img url={url} /> : nameInitial(name) ?? ''}
    </span>
  );
}
