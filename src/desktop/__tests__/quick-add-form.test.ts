// @vitest-environment jsdom
// 快速记录框：Enter 交、输入法组字不算、失败留原文、Esc 收起不清内容、重新拿到焦点回到输入框
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wireQuickAdd, type QuickAddApi } from '../quick-add-form.ts';

let input: HTMLInputElement;
let status: HTMLElement;
let win: EventTarget;
let api: { submit: ReturnType<typeof vi.fn<QuickAddApi['submit']>>; hide: ReturnType<typeof vi.fn<QuickAddApi['hide']>> };

const press = (key: string, init: KeyboardEventInit & { keyCode?: number } = {}): void => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(e, 'keyCode', { value: init.keyCode });
  input.dispatchEvent(e);
};
const settle = (): Promise<void> => new Promise((r) => setTimeout(r));

beforeEach(() => {
  input = document.createElement('input');
  status = document.createElement('p');
  status.hidden = true;
  document.body.replaceChildren(input, status);
  win = new EventTarget();
  api = { submit: vi.fn<QuickAddApi['submit']>().mockResolvedValue(undefined), hide: vi.fn<QuickAddApi['hide']>().mockResolvedValue(undefined) };
  wireQuickAdd({ win: win as unknown as Window, input, status, texts: { failed: 'failed', full: 'full', tooLong: 'tooLong' }, api, maxChars: 20 });
});

describe('快速记录框', () => {
  it('Enter 交去掉首尾空白的一句，成功后清空', async () => {
    input.value = '  明天 10 点开会 ';
    press('Enter');
    await settle();
    expect(api.submit).toHaveBeenCalledExactlyOnceWith('明天 10 点开会');
    expect(input.value).toBe('');
  });

  it('空白不交；发送中再按 Enter 不重复交', async () => {
    input.value = '   ';
    press('Enter');
    expect(api.submit).not.toHaveBeenCalled();
    let done!: () => void;
    api.submit.mockReturnValue(new Promise<void>((r) => (done = r)));
    input.value = '一句话';
    press('Enter');
    press('Enter');
    expect(api.submit).toHaveBeenCalledTimes(1);
    done();
    await settle();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('输入法组字时 Enter、Esc 都不处理 %j', (init) => {
    input.value = 'ni';
    press('Enter', init);
    press('Escape', init);
    expect(api.submit).not.toHaveBeenCalled();
    expect(api.hide).not.toHaveBeenCalled();
    expect(input.value).toBe('ni');
  });

  it('交失败：原文留着、给提示；再打字提示消失', async () => {
    api.submit.mockRejectedValueOnce('boom');
    input.value = '别丢';
    press('Enter');
    await settle();
    expect(input.value).toBe('别丢');
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('failed');
    input.dispatchEvent(new Event('input'));
    expect(status.hidden).toBe(true);
  });

  it('攒满、太长各给各的提示，不叫用户再按一次（11-24 独立评审必修 3）', async () => {
    for (const [code, want] of [['queue_full', 'full'], ['text_too_long', 'tooLong'], [new Error('x'), 'failed']] as const) {
      api.submit.mockRejectedValueOnce(code);
      input.value = '留着';
      press('Enter');
      await settle();
      expect(status.textContent, String(code)).toBe(want);
      expect(input.value).toBe('留着');
    }
  });

  it('字数按字符算（emoji 算一个）：正好上限能交；超了打字时就提示、按 Enter 不交，删回上限以内提示收起', async () => {
    input.value = '😀'.repeat(20);
    input.dispatchEvent(new Event('input'));
    expect(status.hidden).toBe(true);
    press('Enter');
    await settle();
    expect(api.submit).toHaveBeenCalledExactlyOnceWith('😀'.repeat(20));
    input.value = '😀'.repeat(21);
    input.dispatchEvent(new Event('input'));
    expect(status.textContent).toBe('tooLong');
    press('Enter');
    await settle();
    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('😀'.repeat(21));
    input.value = '😀'.repeat(20);
    input.dispatchEvent(new Event('input'));
    expect(status.hidden).toBe(true);
  });

  it('中韩词条一样多，攒满的提示里不叫用户再按', async () => {
    const { quickAddZh } = await import('../../../shared/i18n/quick-add-zh.ts');
    const { quickAddKo } = await import('../../../shared/i18n/quick-add-ko.ts');
    expect(Object.keys(quickAddKo).sort()).toEqual(Object.keys(quickAddZh).sort());
    expect(quickAddZh.full).not.toMatch(/再按/);
  });

  it('Esc 收起但不清内容；窗口重新拿到焦点回到输入框', () => {
    input.value = '写到一半';
    press('Escape');
    expect(api.hide).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('写到一半');
    input.blur();
    win.dispatchEvent(new Event('focus'));
    expect(document.activeElement).toBe(input);
  });
});
