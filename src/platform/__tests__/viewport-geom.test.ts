// 视口几何纯函数（platform/viewport-geom.ts）：iPhone 17 Pro Max 主屏幕版整屏 956、冷启动少顶部安全区 895、键盘弹着 542；网页版、iPad、缩放、横屏
import { describe, expect, it } from 'vitest';
import { fullHeight, isLandscape, KB_MIN_PX, keyboardHeight, viewportGeom, type GeomIn } from '../viewport-geom.ts';

const home = (inner: number, editing: boolean, vv: GeomIn['vv'] = { height: inner, offsetTop: 0 }): GeomIn => ({ inner, vv, full: 956, standalone: true, phone: true, editing });

describe('viewportGeom', () => {
  it('主屏幕版 iPhone 正常（956）：什么都没有', () => {
    expect(viewportGeom(home(956, false))).toEqual({ visible: 956, kb: 0, over: 0, open: false, short: 0, gap: 0, squeeze: true });
  });

  it('冷启动少顶部安全区（895）、没在输入：gap = 61，键盘不算弹着', () => {
    const g = viewportGeom(home(895, false));
    expect(g).toMatchObject({ kb: 0, open: false, short: 61, gap: 61 });
  });

  it('895 但在输入：不补 gap（键盘正在起落），也不算键盘（差值不到 KB_MIN_PX）', () => {
    expect(viewportGeom(home(895, true))).toMatchObject({ kb: 0, open: false, gap: 0 });
  });

  it('键盘弹着、布局视口被压矮（542）：kb = 414，over = 0（--kb 不写），open', () => {
    expect(viewportGeom(home(542, true))).toMatchObject({ kb: 414, over: 0, open: true, gap: 0 });
  });

  it('键盘弹着但焦点已经离开（542、没在输入）：不算弹着，gap 也不补（少的超过 GAP_MAX_PX）', () => {
    expect(viewportGeom(home(542, false))).toMatchObject({ kb: 0, open: false, short: 414, gap: 0 });
  });

  it('键盘压在布局视口上（Safari、iPad：inner 956、可视区 600）：kb = over = 356', () => {
    expect(viewportGeom(home(956, true, { height: 600, offsetTop: 0 }))).toMatchObject({ kb: 356, over: 356, open: true });
    expect(viewportGeom({ ...home(956, false, { height: 600, offsetTop: 0 }), standalone: false, phone: false })).toMatchObject({ kb: 356, over: 356, open: true, squeeze: false });
  });

  it('可视区被滚下去（kb 量出 0）但在输入、可视区比整屏矮一个键盘：仍算弹着', () => {
    expect(viewportGeom(home(956, true, { height: 600, offsetTop: 356 }))).toMatchObject({ kb: 0, open: true });
  });

  it('iPad（不是 iPhone）、网页版：布局视口矮了也不按“被压矮”判，不补 gap', () => {
    for (const over of [{ phone: false }, { standalone: false }]) {
      expect(viewportGeom({ ...home(542, true), ...over })).toMatchObject({ kb: 0, open: false, gap: 0, squeeze: false });
      expect(viewportGeom({ ...home(895, false), ...over })).toMatchObject({ gap: 0 });
    }
  });

  it('双指缩放着（scale ≠ 1）：可视区变小不当键盘', () => {
    expect(viewportGeom(home(956, true, { height: 400, offsetTop: 0, scale: 2 }))).toMatchObject({ kb: 0, over: 0, squeeze: false });
    expect(viewportGeom(home(956, true, { height: 600, offsetTop: 0, scale: 1.005 }))).toMatchObject({ kb: 356 });
  });

  it('没有 visualViewport：可视高度取布局视口高，不量键盘', () => {
    expect(viewportGeom({ ...home(956, false), vv: null })).toMatchObject({ visible: 956, kb: 0, over: 0 });
  });
});

describe('keyboardHeight / 横竖屏 / 整屏高', () => {
  it(`差值不到 ${KB_MIN_PX} 当 0，减掉可视区顶端偏移`, () => {
    expect(keyboardHeight(956, 956 - KB_MIN_PX + 1, 0)).toBe(0);
    expect(keyboardHeight(956, 956 - KB_MIN_PX, 0)).toBe(KB_MIN_PX);
    expect(keyboardHeight(956, 600, 100)).toBe(256);
  });

  it('iOS 的 screen 不随横竖屏转：横屏按 innerWidth 比短边判，整屏取短边', () => {
    const screen = { width: 440, height: 956 };
    expect(isLandscape({ innerWidth: 440, innerHeight: 542, screen })).toBe(false);
    expect(fullHeight({ innerWidth: 440, innerHeight: 542, screen })).toBe(956);
    expect(isLandscape({ innerWidth: 956, innerHeight: 400, screen })).toBe(true);
    expect(fullHeight({ innerWidth: 956, innerHeight: 400, screen })).toBe(440);
  });
});
