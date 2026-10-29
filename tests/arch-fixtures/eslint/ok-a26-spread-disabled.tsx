// arch-fixture: path=src/motion/OkSpread.tsx expect=none
// 对照组（A26-spread）：照 Pressable 的写法，rest 的类型已 Omit 掉链接属性、展开那一行加了豁免注释，应通过；
// 不加注释的同一写法见 a26-spread-props.tsx（要报错）
import type { ButtonHTMLAttributes } from 'react';

type LinkAttr = 'href' | 'src' | 'srcSet' | 'action' | 'formAction' | 'poster' | 'data' | 'xlinkHref';

export function OkSpread(props: Omit<ButtonHTMLAttributes<HTMLButtonElement>, LinkAttr>) {
  const { type, ...rest } = props;
  return (
    <button
      // eslint-disable-next-line lemo/safe-href -- rest 的类型已 Omit 掉链接属性（formAction 等），见接手清单 A26-spread
      {...rest}
      type={type === 'submit' ? 'submit' : 'button'}
    />
  );
}
