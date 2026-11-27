// 今天卡背景缓慢流动：挂在 NowCard 的 <section> 里最后，纯装饰（aria-hidden）。
// 运动全在 NowFlow.module.css（只动 transform，32 秒一圈）；这里只管一件事：这一层不在视口里（卡片滑出屏幕）就写 data-paused，CSS 把动画停住。
// app 切到后台不另外监听：页面藏起来时浏览器本来就不出帧。只在磨砂玻璃皮肤画，挡住简洁皮肤的是样式里 .flow 的 display
import { useEffect, useRef } from 'react';
import styles from './NowFlow.module.css';

export function NowFlow() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') return undefined;
    const sync = (off: boolean): void => {
      el.toggleAttribute('data-paused', off);
    };
    const io = new IntersectionObserver((es) => sync(es.at(-1)?.isIntersecting === false));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={styles.flow} aria-hidden="true" data-testid="now-flow">
      <i className={`${styles.b} ${styles.b1}`} />
      <i className={`${styles.b} ${styles.b2}`} />
      <i className={`${styles.b} ${styles.b3}`} />
      <i className={`${styles.b} ${styles.b4}`} />
    </div>
  );
}
