// swallowNextClick（审查“吞点按五套”合成一套）：吞一次、只吞元素里的、过时限不吞、新的按下和 pointercancel 作废
import { afterEach, describe, expect, it } from 'vitest';
import { swallowNextClick } from '../swallow-click.ts';

let t = 0;
const now = (): number => t;
const click = (el: Element): boolean => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const down = (el: Element): void => void el.dispatchEvent(new Event('pointerdown', { bubbles: true }));

function setup() {
  const box = document.createElement('div');
  const inner = document.createElement('button');
  box.append(inner);
  const other = document.createElement('button');
  document.body.append(box, other);
  return { box, inner, other };
}

afterEach(() => {
  t = 0;
  document.body.replaceChildren();
});

describe('swallowNextClick', () => {
  it('只吞元素里的第一下；落在别处的照常、也不作废', () => {
    const { box, inner, other } = setup();
    swallowNextClick({ within: box, ms: 600, now });
    expect(click(other)).toBe(true);
    expect(click(inner)).toBe(false);
    expect(click(inner)).toBe(true);
  });

  it('不给元素：落在哪儿都吞（一次）', () => {
    const { other } = setup();
    swallowNextClick({ ms: 600, now });
    expect(click(other)).toBe(false);
    expect(click(other)).toBe(true);
  });

  it('过了时限不吞', () => {
    const { box, inner } = setup();
    swallowNextClick({ within: box, ms: 600, now });
    t = 600;
    expect(click(inner)).toBe(true);
  });

  it('新的一次按下、pointercancel：作废（那一下 click 不会再来了）', () => {
    const { box, inner } = setup();
    swallowNextClick({ within: box, ms: 600, now });
    down(inner);
    expect(click(inner)).toBe(true);
    swallowNextClick({ within: box, ms: 600, now });
    inner.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    expect(click(inner)).toBe(true);
  });

  it('在按下的监听里挂上：不被这一次按下自己作废，吞的是这次按下跟着的 click', () => {
    const { box, inner } = setup();
    const onDown = (): void => void swallowNextClick({ within: box, ms: 600, now });
    document.addEventListener('pointerdown', onDown, true);
    down(inner);
    document.removeEventListener('pointerdown', onDown, true);
    expect(click(inner)).toBe(false);
  });

  it('作废函数：调了就不吞，重复调没事', () => {
    const { box, inner } = setup();
    const off = swallowNextClick({ within: box, ms: 600, now });
    off();
    off();
    expect(click(inner)).toBe(true);
  });
});
