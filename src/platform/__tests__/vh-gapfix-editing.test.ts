// 冷启动高度校正在输入框聚焦、键盘弹起那段时间里不动页面（视口几何返修 11-11：台账 Q-8“光标偏约 62pt”、Q-24“点＋有时不弹键盘”都在这段时间，
// 62 正好是垫块多出的 gap+1）。等底栏后、收键盘后两次：innerHeight 一变就撤（中间值也撤；早试才只认回整屏）、弹键盘压到 542 当帧撤且不滚；
// 聚焦着不放新垫块、不补滚 1px；做着时来的“键盘收了”这次不接、不排队，等下一次视口事件；冷启动那次做着时又聚焦，撤了以后也不放；
// 收键盘那次顶部安全区读到 0 不重读、直接不做
import { describe, expect, it, vi } from 'vitest';
import { KB_SETTLE_MS } from '../viewport.ts';
import { GIVE_UP_MS, readGapFixLog, SCROLL_AT_MS, startGapFix } from '../vh-gapfix.ts';
import { coldThenKeyboard, deps, frames, input, mockScroll, mountBar, pad, resize, setInner, settle, startKb, st, vvResize } from './gapfix-fixture.ts';

const kbPads = (): number => readGapFixLog().match(/kb pad /g)?.length ?? 0;

describe('等底栏后那次', () => {
  it('等底栏后那次 innerHeight 一变就撤（变到 896 这种中间值也撤，和改前 padFix 一样；只认回整屏的是早试）', () => {
    mockScroll();
    mountBar();
    const f = frames();
    startGapFix(f.frame, deps());
    expect(pad()).not.toBeNull();
    setInner(896);
    st.clock = 30;
    f.flush();
    expect(pad()).toBeNull();
    expect(f.size).toBe(0);
    expect(readGapFixLog()).toMatch(/changed 895->896 by-pad pad-removed inner=896/);
  });

  it('垫块在时点“＋”弹键盘（聚焦 + innerHeight 压到 542）：当帧撤掉垫块，之后不滚', () => {
    const { by, to } = mockScroll();
    mountBar();
    const f = frames();
    startGapFix(f.frame, deps());
    st.clock = 100;
    f.flush();
    expect(pad()).not.toBeNull();
    input().focus();
    setInner(542);
    st.clock = 120;
    f.flush();
    expect(pad()).toBeNull();
    st.clock = SCROLL_AT_MS + 10;
    f.flush(5);
    expect(by).not.toHaveBeenCalled();
    expect(to).not.toHaveBeenCalled();
    expect(readGapFixLog()).toMatch(/changed 895->542 by-pad pad-removed inner=542/);
  });

  it(`垫块在时聚焦了输入框、innerHeight 还没变：到 ${SCROLL_AT_MS}ms 不补滚，记 scroll-skipped editing；到点照样撤`, () => {
    const { by, to } = mockScroll();
    mountBar();
    const f = frames();
    startGapFix(f.frame, deps());
    input().focus();
    st.clock = SCROLL_AT_MS;
    f.flush(2);
    expect(by).not.toHaveBeenCalled();
    expect(readGapFixLog()).toMatch(/scroll-skipped editing y=0/);
    st.clock = GIVE_UP_MS;
    f.flush(2);
    expect(pad()).toBeNull();
    expect(to).not.toHaveBeenCalled();
  });

  it('底栏挂上时已经有输入框聚焦着：不放垫块，记 skip editing', () => {
    const f = frames();
    startGapFix(f.frame, deps());
    input().focus();
    mountBar();
    f.flush();
    expect(pad()).toBeNull();
    expect(f.size).toBe(0);
    expect(readGapFixLog()).toMatch(/skip editing inner=895/);
  });

});

describe('收键盘那次', () => {
  it('冷启动那次做着时键盘收了：不排队，冷启动那次一撤也不当场做；静等下一次视口事件', () => {
    mockScroll();
    const f = frames();
    mountBar();
    startKb(f.frame);
    expect(pad()).not.toBeNull();
    // 冷启动那次还在（innerHeight 没变）时：别处弹过键盘又收了，watcher 报“真收了”
    const el = input();
    el.focus();
    vvResize(542);
    el.blur();
    vvResize(895);
    settle();
    expect(readGapFixLog()).toMatch(/kb skip busy/);
    expect(kbPads()).toBe(0);
    st.clock += GIVE_UP_MS;
    f.flush(3);
    expect(pad()).toBeNull();
    expect(readGapFixLog()).toMatch(/no-change pad-removed/);
    // 冷启动那次撤了：不当场做 kb
    settle();
    expect(pad()).toBeNull();
    expect(kbPads()).toBe(0);
    // 下一次视口事件（还上着膛）静下来才做
    vvResize(895);
    settle();
    expect(pad()).not.toBeNull();
    expect(kbPads()).toBe(1);
  });

  it('冷启动排队期间又聚焦（点“＋”，innerHeight 还停在 895）：冷启动那次撤了以后不放 kb 垫块；离开输入框静了 KB_SETTLE_MS 才放', () => {
    mockScroll();
    const f = frames();
    mountBar();
    startKb(f.frame);
    expect(pad()).not.toBeNull();
    const el = input();
    el.focus();
    vvResize(542);
    el.blur();
    vvResize(895);
    settle();
    expect(kbPads()).toBe(0);
    // 又点了“＋”：聚焦，iOS 还没把 innerHeight 压矮
    el.focus();
    st.clock += GIVE_UP_MS;
    f.flush(3);
    expect(pad()).toBeNull();
    settle();
    expect(pad()).toBeNull();
    expect(kbPads()).toBe(0);
    el.blur();
    vi.advanceTimersByTime(KB_SETTLE_MS - 1);
    expect(pad()).toBeNull();
    settle();
    expect(pad()).not.toBeNull();
    expect(kbPads()).toBe(1);
  });

  it('收键盘那次 innerHeight 一变就撤（变到 896 这种中间值也撤，和改前一样）', () => {
    mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    settle();
    expect(pad()).not.toBeNull();
    setInner(896);
    f.flush();
    expect(pad()).toBeNull();
    expect(readGapFixLog()).toMatch(/kb changed 895->896 by-pad pad-removed inner=896/);
  });

  it('收键盘那次垫块在时又点“＋”弹键盘（聚焦 + 542）：当帧撤掉垫块，之后不滚', () => {
    const { by, to } = mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    settle();
    expect(pad()).not.toBeNull();
    const el = input();
    el.focus();
    resize(542);
    f.flush();
    expect(pad()).toBeNull();
    st.clock += SCROLL_AT_MS;
    f.flush(5);
    expect(by).not.toHaveBeenCalled();
    expect(to).not.toHaveBeenCalled();
    expect(readGapFixLog()).toMatch(/kb changed 895->542 by-pad pad-removed inner=542/);
  });

  it(`收键盘那次垫块在时聚焦了输入框、innerHeight 还没变：到 ${SCROLL_AT_MS}ms 不补滚，记 kb scroll-skipped editing`, () => {
    const { by } = mockScroll();
    const f = frames();
    coldThenKeyboard(f);
    settle();
    expect(pad()).not.toBeNull();
    input().focus();
    st.clock += SCROLL_AT_MS;
    f.flush(2);
    expect(by).not.toHaveBeenCalled();
    expect(readGapFixLog()).toMatch(/kb scroll-skipped editing y=0/);
  });

  it('收键盘那次顶部安全区读到 0：不重读，直接 kb skip（改前就是这样）', () => {
    mockScroll();
    const f = frames();
    const reads = [61];
    mountBar();
    startKb(f.frame, { top: () => reads.shift() ?? 0 });
    setInner(956);
    f.flush();
    const el = input();
    el.focus();
    resize(542);
    el.blur();
    resize(895);
    settle();
    expect(pad()).toBeNull();
    expect(f.size).toBe(0);
    expect(readGapFixLog()).toMatch(/kb skip gap-not-top\(gap=61 top=0\) top=0/);
  });

});
