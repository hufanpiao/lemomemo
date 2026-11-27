// 快速记录框的交互（纯 DOM，好测）：
// • Enter 交给 main，成功清空（窗口由 Rust 收起）；失败留着原文，按 Rust 回的错误码给提示：攒满了（main 一直没来取）叫用户先打开主窗口，
//   太长了说上限，别的才叫再按一次（11-24 独立评审必修 3：攒满时叫用户再按一次是误导）；空白不交，发送中不重复交
// • 输入法组字时的 Enter、Esc 归输入法（中文、韩文选词不能当成提交或收起）
// • Esc 收起但不清内容：误触或切走再唤出，写到一半的字还在
// • 窗口每次拿到焦点都把光标放回输入框（窗口是隐藏再显示，不会重新载入）

export interface QuickAddApi {
  submit(text: string): Promise<void>;
  hide(): Promise<void>;
}

/** 提示文案：failed 一般失败（再按一次），full 待取队列攒满，tooLong 超过字数上限 */
export interface QuickAddTexts {
  readonly failed: string;
  readonly full: string;
  readonly tooLong: string;
}

export interface QuickAddParts {
  readonly win: Pick<Window, 'addEventListener'>;
  readonly input: HTMLInputElement;
  readonly status: HTMLElement;
  readonly texts: QuickAddTexts;
  readonly api: QuickAddApi;
  /** 一句最多多少个字（按字符算，emoji、生僻字算一个；不用 input.maxLength，它按 UTF-16 单元算） */
  readonly maxChars: number;
}

/** Rust 回的错误码（quick_add.rs 的 push）→ 提示 */
export function failText(code: unknown, texts: QuickAddTexts): string {
  if (code === 'queue_full') return texts.full;
  if (code === 'text_too_long') return texts.tooLong;
  return texts.failed;
}

export function wireQuickAdd({ win, input, status, texts, api, maxChars }: QuickAddParts): void {
  let sending = false;
  const clearStatus = (): void => {
    status.hidden = true;
    status.textContent = '';
  };
  const show = (text: string): void => {
    status.textContent = text;
    status.hidden = false;
  };
  const tooLong = (): boolean => [...input.value.trim()].length > maxChars;
  const send = async (): Promise<void> => {
    const text = input.value.trim();
    if (!text || sending) return;
    if (tooLong()) return show(texts.tooLong);
    sending = true;
    clearStatus();
    try {
      await api.submit(text);
      input.value = '';
    } catch (e) {
      show(failText(e, texts));
    } finally {
      sending = false;
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      void send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void api.hide().catch(() => undefined);
    }
  });
  // 打字时：超过上限当场提示（不截断，用户自己删），没超过就收起提示
  input.addEventListener('input', () => (tooLong() ? show(texts.tooLong) : clearStatus()));
  win.addEventListener('focus', () => input.focus());
  input.focus();
}
