// 页面左上角的返回按钮只在这里画（架构 10.1）：“‹ 文字”，“‹”只是样子，读屏只读文字。
// 设置首页的“‹ 今天”是链接（要能新标签页打开，href 只能写 hrefOf），还在设置页里自己画，样式同一段
import { Pressable } from '../../motion/components.ts';
import styles from './BackLink.module.css';

export function BackLink({ label, onBack, testId }: { label: string; onBack(): void; testId: string }) {
  return (
    <Pressable className={styles.back} onClick={onBack} data-testid={testId}>
      <span aria-hidden="true">‹</span> {label}
    </Pressable>
  );
}
