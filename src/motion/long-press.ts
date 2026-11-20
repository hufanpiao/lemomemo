// 长按一个按钮出它的菜单（负责人 11-19：隐私记“长按分类格可以改名、删除”；随手记“其他可以自己编辑分类”，分类胶囊同一个做法）。
// 11-21 从 kit/hooks/useLongPress.ts 挪到这里（改善报告第三节第 4 块）：吃掉随后那次点按要用 motion 的 swallowNextClick，kit 的钩子层不许引 motion；
// 按住时长也直接用长按拖动拿起的 LIFT_MS，不再两处各写一个 400。
// • 按住 LIFT_MS 不动就触发 onLong；挪动超过 SLOP_PX、抬手、取消都作废。
//   时长同长按拖动拿起（独立评审 11-19 低 19：同一屏上格子和“最近”两种长按手感一致）
// • 触发以后在这个按钮上抬手：随后补来的那一下 click 吞掉（swallow-click.ts 的 swallowNextClick，只吞落在按钮里的），不再进这一类
// • 电脑上右键、键盘菜单键（contextmenu）同样触发；contextmenu 不吞下一次点按（独立评审 11-19 中 8：
//   键盘菜单键触发后，关掉弹窗再按回车点这个胶囊会被吞掉）。同一次按住计时器已经触发过，随后的 contextmenu（安卓长按两个都来）不再触发第二次
// • iPhone 长按按钮不出系统菜单、不选字：返回的属性里带 data-long-press，样式在 kit/components/Chip.module.css（独立评审 11-19 中 11）
// • 只认第一根手指、主键；不抓指针、不 preventDefault（竖着滚照常）
// 返回给按钮展开的几个事件和标记；运行日志由调用处记
import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';
import { LIFT_MS } from './long-press-drag.ts';
import { swallowNextClick } from './swallow-click.ts';

const SLOP_PX = 8;

export interface LongPressProps {
  onPointerDown(e: PointerEvent): void;
  onPointerMove(e: PointerEvent): void;
  onPointerUp(e: PointerEvent): void;
  onPointerCancel(): void;
  onPointerLeave(): void;
  onContextMenu(e: MouseEvent): void;
  'data-long-press': '';
}

export function useLongPress(onLong: () => void): LongPressProps {
  const cb = useRef(onLong);
  cb.current = onLong;
  const st = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** 这一次按住计时器已经触发：抬手时吞掉随后的那次点按、不再认 contextmenu */
  const fired = useRef(false);
  const stop = (): void => {
    if (st.current) clearTimeout(st.current.timer);
    st.current = null;
  };
  useEffect(() => stop, []);
  return {
    onPointerDown(e) {
      stop();
      fired.current = false;
      if (!e.isPrimary || e.button !== 0) return;
      st.current = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          st.current = null;
          fired.current = true;
          cb.current();
        }, LIFT_MS),
      };
    },
    onPointerMove(e) {
      const s = st.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP_PX) stop();
    },
    onPointerUp(e) {
      stop();
      if (!fired.current) return;
      fired.current = false;
      if (e.currentTarget instanceof Node) swallowNextClick({ within: e.currentTarget });
    },
    onPointerCancel: stop,
    onPointerLeave: stop,
    onContextMenu(e) {
      e.preventDefault();
      stop();
      if (fired.current) return;
      cb.current();
    },
    'data-long-press': '',
  };
}
