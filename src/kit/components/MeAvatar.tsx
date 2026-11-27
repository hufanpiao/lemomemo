// 本人头像圈：有头像（设置 › 账号里换的）画圆形图片；没头像、还在取、取不到时画名字第一个字，没有名字画人形
// 四页右上角的设置入口（MeLink）、设置首页账号一行、电脑版侧栏的设置入口共用这一个（同一组件、同样尺寸）；
// 外框 var(--hit) 见方，圆圈内缩 4px（图片也裁在这个圈里）；只是装饰（aria-hidden），可点的按钮 / 链接由使用方包
// size="lg"：设置 › 账号顶部的大头像（同一套取图，只是大）
// bare：不画自己的底圈，用外层已有的圈（电脑版侧栏的设置入口：圈和悬停变色在底栏的 GlassBar.module.css，那个文件哈希钉死不许改）
import { useBlobSrc } from '../hooks/useBlobSrc.ts';
import { useMeAvatar } from '../hooks/useMeAvatar.ts';
import { useMeInitial } from '../hooks/useMeInitial.ts';
import styles from './MeAvatar.module.css';

function Img({ url }: { url: string }) {
  const ref = useBlobSrc(url);
  return <img ref={ref} className={styles.img} alt="" draggable={false} />;
}

export function MeAvatar({ testId, size, bare }: { testId?: string; size?: 'lg'; bare?: boolean }) {
  const initial = useMeInitial();
  const url = useMeAvatar();
  return (
    <span className={`${styles.avatar} ${size === 'lg' ? styles.lg : ''} ${bare ? styles.bare : ''}`} aria-hidden="true" data-testid={testId} data-has-img={url ? '' : undefined}>
      {url ? (
        <Img url={url} />
      ) : (
        initial ?? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0" />
          </svg>
        )
      )}
    </span>
  );
}
