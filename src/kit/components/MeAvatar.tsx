// 本人头像圈：名字第一个字，没有名字画人形（负责人 11-05 ①）
// 今天页右上角的设置入口和设置首页账号一行共用这一个（负责人 11-05：同一组件、同样尺寸）；
// 外框 var(--hit) 见方，圆圈内缩 4px；只是装饰（aria-hidden），可点的按钮 / 链接由使用方包
import { useMeInitial } from '../hooks/useMeInitial.ts';
import styles from './MeAvatar.module.css';

export function MeAvatar({ testId }: { testId?: string }) {
  const initial = useMeInitial();
  return (
    <span className={styles.avatar} aria-hidden="true" data-testid={testId}>
      {initial ?? (
        <svg viewBox="0 0 24 24">
          <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0" />
        </svg>
      )}
    </span>
  );
}
