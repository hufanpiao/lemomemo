// 按下回弹（架构 17.1、17.3）：样式挂在 data-state 上，组件只改标记（17.2 第 2 点）
// 缩放和时长写在 CSS（var(--dur-press)、var(--ease-spring)），这里不碰 style
import { useState, type ButtonHTMLAttributes } from 'react';
import styles from './Pressable.module.css';

// A26-spread：下面把 rest 整个展开到 <button> 上。光靠类型挡不住（{...p}、as object、小写 formaction 都能传进来），
// 所以两层：类型里 Omit 掉链接属性；展开前在运行时按 A26 规则那张表（build/eslint-rules/safe-href.js 的 URL_ATTRS）
// 去掉 rest 里的链接类键，大小写不敏感、'xlink:href' 去掉冒号再比。两边的表要一起改
type LinkAttr = 'href' | 'src' | 'srcSet' | 'action' | 'formAction' | 'poster' | 'data' | 'xlinkHref';
type PressableProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, LinkAttr>;
const LINK_KEYS = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'data', 'xlinkhref']);

function dropLinkAttrs<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !LINK_KEYS.has(k.toLowerCase().replace(':', '')))) as T;
}

export function Pressable(props: PressableProps) {
  const { className, onPointerDown, onPointerUp, onPointerLeave, onPointerCancel, type, ...rest } = props;
  const safeRest = dropLinkAttrs(rest);
  const [pressed, setPressed] = useState(false);
  return (
    <button
      // eslint-disable-next-line lemo/safe-href -- safeRest 已在运行时去掉链接类键（dropLinkAttrs，大小写不敏感），类型也 Omit 掉了；见接手清单 A26-spread
      {...safeRest}
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
