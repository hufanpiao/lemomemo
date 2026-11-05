// 日历页点“＋”带上选中的那天（B2 FA-7 第 5 项，hooks/new-date.ts）
import { afterEach, describe, expect, it } from 'vitest';
import { clearNewDate, pendingNewDate, watchAddClick } from '../hooks/new-date.ts';

afterEach(() => {
  clearNewDate();
  document.body.replaceChildren();
});

function addButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.dataset['testid'] = 'tabbar-add';
  b.append(document.createElement('span')); // 点在按钮里的图标上也算
  document.body.append(b);
  return b;
}

describe('watchAddClick', () => {
  it('点“＋”（含里面的图标）那一刻记下选中的日期；点别处不记', () => {
    let sel = '2026-11-09';
    const stop = watchAddClick(() => sel);
    const other = document.createElement('button');
    document.body.append(other);
    other.click();
    expect(pendingNewDate()).toBeNull();
    const add = addButton();
    (add.firstElementChild as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(pendingNewDate()).toBe('2026-11-09');
    sel = '2026-11-12';
    add.click();
    expect(pendingNewDate()).toBe('2026-11-12');
    stop();
  });

  it('日历页卸载（取消）以后点“＋”不记；clearNewDate 清掉', () => {
    const stop = watchAddClick(() => '2026-11-09');
    const add = addButton();
    add.click();
    clearNewDate();
    expect(pendingNewDate()).toBeNull();
    stop();
    add.click();
    expect(pendingNewDate()).toBeNull();
  });
});
