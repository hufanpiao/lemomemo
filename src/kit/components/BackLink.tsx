// 页面左上角的返回按钮只在这里画（架构 10.1）：“‹ 文字”，“‹”只是样子，读屏只读文字。样式 BackLink.module.css 的 .back 也只这一份。
// 例外一处：设置首页的“‹ 今天”是链接（要能新标签页打开，href 只能写 hrefOf），在设置页里自己写 <a>，直接用本组件的 .back 样式。
// mark：“‹”和文字中间的小图标（隐私记记录页的线框小锁，记录页美化方向 A：“‹ 🔒 隐私记”，三样之间各隔 4）
import type { ReactNode } from 'react';
import { Pressable } from '../../motion/components.ts';
import styles from './BackLink.module.css';

export function BackLink({ label, onBack, testId, disabled, mark }: { label: string; onBack(): void; testId: string; disabled?: boolean; mark?: ReactNode | undefined }) {
  return (
    <Pressable className={styles.back} onClick={onBack} disabled={disabled} data-testid={testId}>
      {/* 包一层：.back 是 inline-flex，“‹”和文字直接放进去时中间的空格会被丢掉，两个字贴在一起 */}
      {mark ? (
        <span className={styles.marked}>
          <span aria-hidden="true">‹</span>
          {mark}
          {label}
        </span>
      ) : (
        <span>
          <span aria-hidden="true">‹</span> {label}
        </span>
      )}
    </Pressable>
  );
}
