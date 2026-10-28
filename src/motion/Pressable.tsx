// 按下回弹（架构 17.1、17.3）：样式挂在 data-state 上，组件只改标记（17.2 第 2 点）
// 缩放和时长写在 CSS（var(--dur-press)、var(--ease-spring)），这里不碰 style
import { useState, type ButtonHTMLAttributes } from 'react';
import styles from './Pressable.module.css';

export function Pressable(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className, onPointerDown, onPointerUp, onPointerLeave, onPointerCancel, type, ...rest } = props;
  const [pressed, setPressed] = useState(false);
  return (
    <button
      {...rest}
      type={type === 'submit' || type === 'reset' ? type : 'button'}
      className={className ? `${styles.pressable} ${className}` : styles.pressable}
      data-state={pressed ? 'pressed' : 'idle'}
      onPointerDown={(e) => {
        setPressed(true);
        onPointerDown?.(e);
      }}
      onPointerUp={(e) => {
        setPressed(false);
        onPointerUp?.(e);
      }}
      onPointerLeave={(e) => {
        setPressed(false);
        onPointerLeave?.(e);
      }}
      // 手指按下后开始滚动，触屏浏览器发 pointercancel、不发 pointerup：要在这里松开，不然一直停在按下（缩小或变淡）
      onPointerCancel={(e) => {
        setPressed(false);
        onPointerCancel?.(e);
      }}
    />
  );
}
