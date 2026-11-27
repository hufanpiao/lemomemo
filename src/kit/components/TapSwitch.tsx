// 藏在按钮里的真系统开关（iOS 上只有手指真点到 <input type="checkbox" switch> 才震，脚本代点一律不震）：
// 放进要震的按钮里当最后一个孩子，盖满按钮、看不见（TapSwitch.module.css），手指点按钮其实点在它上面，click 照样冒泡到按钮、按钮的 onClick 照常。
// • 震不震：按钮的 onClick 里调了该震的 fx（platform/fx-api.ts 记下）才放这一下切开关、iOS 出触感；没调（只读拦下、“声音和触感”关着、
//   不是 iOS）就在 click 走完以后 preventDefault，开关不切、不震。判断挂在 window 的 click 上：按钮的 onClick（React 挂在根上）先跑完才轮到它
// • 读屏、键盘：aria-hidden、tabIndex -1，读屏还是只读按钮本身；点到它时焦点交给按钮（同原来点按钮）
// • 只管手指点一下的按钮：长按、拖动、下拉没有 click，iOS 上震不了（feedback.ts 文件头）
import { useEffect, useRef } from 'react';
import { takeBuzz } from '../hooks/tapBuzz.ts';
import styles from './TapSwitch.module.css';

export function TapSwitch() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // switch 属性 React 不认识，挂上以后补
    el.setAttribute('switch', '');
    const late = (ev: MouseEvent): void => {
      if (ev.target !== el) return;
      window.removeEventListener('click', late);
      if (!takeBuzz()) ev.preventDefault();
    };
    const onClick = (): void => {
      window.removeEventListener('click', late);
      window.addEventListener('click', late);
    };
    el.addEventListener('click', onClick);
    return () => {
      el.removeEventListener('click', onClick);
      window.removeEventListener('click', late);
    };
  }, []);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={styles.tap}
      aria-hidden="true"
      tabIndex={-1}
      data-tap-switch=""
      onFocus={(e) => {
        const host = e.currentTarget.parentElement;
        if (host instanceof HTMLElement) host.focus();
      }}
    />
  );
}
