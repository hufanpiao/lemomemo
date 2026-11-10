// 切页过渡中落在 <html> 上的点按、底栏没接住的（设计复审三 R6，主持人 11-05 做法 A）：首屏后部分 GlassBarFx 按坐标替页面内容代点
// 过渡开始 50 ms 以内的丢掉；只代点导航类的链接、按钮（主持人 11-05 收紧：复选框、开关、单选、切换按钮、表单控件、label 都不点，
// 带 data-no-proxy 的危险按钮也不点，设计复审五 R6-a）；禁用的、inert / aria-hidden 里的不点；
// 没在过渡里（没有 ::view-transition 动画）不管。jsdom 没有过渡：getAnimations、elementFromPoint 用替身
import { act, cleanup, fireEvent, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlassBar } from '../GlassBar.tsx';
import { EARLY_MS, HIT_MS } from '../GlassBarFx.tsx';

vi.mock('../../../../motion/glass-ghost.ts', () => ({ startGlass: () => ({ stop: () => undefined, poke: () => undefined }), playGel: () => true, forgetTilt: () => undefined }));

let anims: Array<{ effect: { pseudoElement: string }; currentTime: number; finish: () => void }> = [];
let under: Element | null = null;
const page = document.createElement('main');
let view: RenderResult;

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  anims = [];
  under = null;
  page.replaceChildren();
  document.body.append(page);
  Object.defineProperty(document, 'getAnimations', { configurable: true, value: () => anims });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => under });
  view = render(<GlassBar active="today" />);
  await waitFor(() => expect(screen.getByTestId('tabbar-band')).toBeTruthy());
  await act(async () => undefined); // 模糊带画出来时 Fx 的 useEffect（挂点按处理）可能还没跑：冲一下
});
afterEach(() => {
  cleanup();
  page.remove();
  vi.useRealTimers();
  delete (document as unknown as Record<string, unknown>)['getAnimations'];
  delete (document as unknown as Record<string, unknown>)['elementFromPoint'];
});

/** 过渡跑到 at 毫秒处 */
const inTransition = (at: number) => {
  const finish = vi.fn();
  anims = [{ effect: { pseudoElement: '::view-transition-new(root)' }, currentTime: at, finish }];
  return finish;
};
/** 在 <html> 上点一下（坐标在页面中间，不在底栏上），把代点的等待走完 */
const tapHtml = async () => {
  document.documentElement.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
};
const put = <T extends HTMLElement>(el: T): T => {
  page.append(el);
  return el;
};

describe('过渡中点页面内容（R6）', () => {
  it('过渡开始 50 ms 以后：先把过渡放完，再替按钮点一下', async () => {
    const btn = put(document.createElement('button'));
    const onClick = vi.fn();
    btn.addEventListener('click', onClick);
    under = btn;
    const finish = inTransition(EARLY_MS + 30);
    await tapHtml();
    expect(finish).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('过渡开始 50 ms 以内：丢掉，不放完过渡、不代点', async () => {
    const btn = put(document.createElement('button'));
    const onClick = vi.fn();
    btn.addEventListener('click', onClick);
    under = btn;
    const finish = inTransition(EARLY_MS - 10);
    await tapHtml();
    expect(finish).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('不在过渡里：不管（点在空白处）', async () => {
    const btn = put(document.createElement('button'));
    const onClick = vi.fn();
    btn.addEventListener('click', onClick);
    under = btn;
    await tapHtml();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('点到按钮里面的字也算按钮；不是链接、按钮、label、表单控件的不点', async () => {
    const btn = put(document.createElement('button'));
    const span = document.createElement('span');
    btn.append(span);
    const onClick = vi.fn();
    btn.addEventListener('click', onClick);
    under = span;
    inTransition(100);
    await tapHtml();
    expect(onClick).toHaveBeenCalledTimes(1);
    const div = put(document.createElement('div'));
    const onDiv = vi.fn();
    div.addEventListener('click', onDiv);
    under = div;
    inTransition(100);
    await tapHtml();
    expect(onDiv).not.toHaveBeenCalled();
  });

  it('禁用的（disabled、aria-disabled）、inert 里的、aria-hidden 里的都不点', async () => {
    const cases: HTMLElement[] = [];
    const b1 = document.createElement('button');
    b1.disabled = true;
    const b2 = document.createElement('button');
    b2.setAttribute('aria-disabled', 'true');
    const wrapInert = document.createElement('div');
    wrapInert.setAttribute('inert', '');
    const b3 = document.createElement('button');
    wrapInert.append(b3);
    const wrapHidden = document.createElement('div');
    wrapHidden.setAttribute('aria-hidden', 'true');
    const b4 = document.createElement('a');
    b4.href = '#/settings';
    wrapHidden.append(b4);
    page.append(b1, b2, wrapInert, wrapHidden);
    cases.push(b1, b2, b3, b4);
    for (const el of cases) {
      const spy = vi.fn((e: Event) => e.preventDefault());
      el.addEventListener('click', spy);
      under = el;
      inTransition(100);
      await tapHtml();
      expect(spy, `${el.tagName} ${[...el.attributes].map((a) => a.name).join(" ")} ${el.parentElement?.getAttribute("inert") ?? ""}`).not.toHaveBeenCalled();
    }
  });

  it('不点非导航类：复选框（含 label 包着的）、开关、单选、切换按钮、文字输入、下拉、带 data-no-proxy 的删除按钮；对照：普通链接照点', async () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    const lab = document.createElement('label');
    const inLab = document.createElement('input');
    inLab.type = 'checkbox';
    inLab.setAttribute('role', 'switch');
    const labText = document.createElement('span');
    lab.append(inLab, labText);
    const sw = document.createElement('button');
    sw.setAttribute('role', 'switch');
    const radio = document.createElement('div');
    radio.setAttribute('role', 'radio');
    radio.tabIndex = 0;
    const radioWrap = document.createElement('button'); // 按钮里套着 role=radio：点到的是 radio
    radioWrap.append(radio);
    const pressed = document.createElement('button');
    pressed.setAttribute('aria-pressed', 'false');
    const text = document.createElement('input');
    const sel = document.createElement('select');
    const del = document.createElement('button');
    del.dataset['noProxy'] = '';
    const delIcon = document.createElement('span');
    del.append(delIcon);
    page.append(box, lab, sw, radioWrap, pressed, text, sel, del);
    const cases: Array<[string, Element, HTMLElement]> = [
      ['复选框', box, box],
      ['label 里的字（开关）', labText, inLab],
      ['role=switch 按钮', sw, sw],
      ['按钮里的 role=radio', radio, radioWrap],
      ['aria-pressed 切换按钮', pressed, pressed],
      ['文字输入', text, text],
      ['下拉', sel, sel],
      ['data-no-proxy 删除按钮里的图标', delIcon, del],
    ];
    for (const [name, hitEl, target] of cases) {
      const spy = vi.fn((e: Event) => e.preventDefault());
      target.addEventListener('click', spy);
      under = hitEl;
      inTransition(100);
      await tapHtml();
      expect(spy, name).not.toHaveBeenCalled();
      expect(document.activeElement, name).not.toBe(target);
    }
    expect(box.checked).toBe(false);
    expect(inLab.checked).toBe(false);
    const link = put(document.createElement('a'));
    link.href = '#/settings';
    const onLink = vi.fn((e: Event) => e.preventDefault());
    link.addEventListener('click', onLink);
    under = link;
    inTransition(100);
    await tapHtml();
    expect(onLink).toHaveBeenCalledTimes(1);
  });

  it('伪元素层还没撤（elementFromPoint 还是 <html>）：隔一会儿再找，撤了以后点到', async () => {
    const btn = put(document.createElement('button'));
    const onClick = vi.fn();
    btn.addEventListener('click', onClick);
    under = document.documentElement;
    inTransition(100);
    document.documentElement.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(onClick).not.toHaveBeenCalled();
    under = btn;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('机器慢、伪元素层 1 秒多才撤（CI 的 Linux webkit，11-06）：还在等，撤了以后照样点到；一直撤不掉的约 2 秒后放弃', async () => {
    const btn = put(document.createElement('button'));
    const onClick = vi.fn();
    btn.addEventListener('click', onClick);
    under = document.documentElement;
    inTransition(100);
    document.documentElement.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(onClick).not.toHaveBeenCalled();
    under = btn;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    under = document.documentElement;
    inTransition(100);
    document.documentElement.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HIT_MS + 100);
    });
    under = btn;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(onClick).toHaveBeenCalledTimes(1); // 放弃以后不再点
  });
});

describe('等待中的代点可以取消（代码审查 p1 M1、M2、S1）', () => {
  /** 伪元素层一直没撤的过渡中点一下页面中间：代点进入等待 */
  const waiting = async () => {
    const btn = put(document.createElement('button'));
    const onClick = vi.fn();
    btn.addEventListener('click', onClick);
    under = document.documentElement;
    inTransition(100);
    document.documentElement.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    return { btn, onClick };
  };
  const later = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
  };

  it('用户自己又按下：取消等待中的代点（不会导航两次）', async () => {
    const { btn, onClick } = await waiting();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    under = btn;
    await later();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('等待中换了路由：放弃', async () => {
    const { btn, onClick } = await waiting();
    const before = location.href;
    history.pushState(null, '', '#/todos');
    under = btn;
    await later();
    expect(onClick).not.toHaveBeenCalled();
    history.replaceState(null, '', before);
  });

  it('等待中又进入新的过渡：放弃，不点到新页面', async () => {
    const { btn, onClick } = await waiting();
    inTransition(10);
    under = btn;
    await later();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('卸载：不再代点，定时器清零', async () => {
    const { btn, onClick } = await waiting();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    under = btn;
    await later();
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('底栏的页签（R4）：键盘弹着、inert 时不代点（代码审查 L15、L16）', () => {
  const rect = { left: 150, right: 210, top: 700, bottom: 750, x: 150, y: 700, width: 60, height: 50, toJSON: () => ({}) };
  const hook = () => {
    const todos = document.querySelector<HTMLElement>('a[data-tab="todos"]') as HTMLElement; // 键盘弹着时整条 visibility: hidden，按读屏角色找不到
    todos.getBoundingClientRect = () => rect;
    const clicked = vi.fn((e: Event) => e.preventDefault()); // 不真跳 hash
    todos.addEventListener('click', clicked);
    return clicked;
  };

  it('平常：过渡中点在“待办”上替它点（对照）', () => {
    const clicked = hook();
    fireEvent.click(document.documentElement, { clientX: 170, clientY: 720 });
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('键盘弹着（底栏 data-kb、visibility: hidden）：不替页签点', () => {
    view.rerender(<GlassBar active="today" hide />);
    screen.getByRole('navigation', { hidden: true }).style.setProperty('visibility', 'hidden'); // jsdom 不算 CSS Modules 的样式，直接写
    const clicked = hook();
    fireEvent.click(document.documentElement, { clientX: 170, clientY: 720 });
    expect(clicked).not.toHaveBeenCalled();
  });

  it('底栏在 inert 里（例如弹层开着时页面被设 inert）：不替页签点', () => {
    const clicked = hook();
    screen.getByRole('navigation').parentElement?.setAttribute('inert', '');
    fireEvent.click(document.documentElement, { clientX: 170, clientY: 720 });
    expect(clicked).not.toHaveBeenCalled();
  });
});
