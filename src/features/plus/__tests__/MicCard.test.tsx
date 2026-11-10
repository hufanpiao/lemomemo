// 麦克风说明卡（B3 S23）：两种卡的文案照定稿线框原文，主次按钮各回调到对的地方
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type * as Env from '../../../platform/env.ts';
let ios = true;
vi.mock('../../../platform/env.ts', async (orig) => ({ ...(await orig<typeof Env>()), isAppleMobile: () => ios }));
const { default: MicCard } = await import('../ui/MicCard.tsx');
type MicCardKind = 'ask' | 'denied';

const onRetry = vi.fn();
const onType = vi.fn();
const onOpenChange = vi.fn();
const show = (kind: MicCardKind) => render(<MicCard open kind={kind} onOpenChange={onOpenChange} onRetry={onRetry} onType={onType} />);

beforeEach(() => {
  ios = true;
  uiStore.setState({ locale: 'zh-CN' });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MicCard', () => {
  it('第一次按住：标题、说明；主按钮“允许麦克风”→ onRetry，次按钮“先只用打字”→ onType', () => {
    show('ask');
    const dlg = screen.getByRole('dialog');
    expect(dlg.textContent).toContain('按住“＋”说话，要先允许用麦克风');
    expect(dlg.textContent).toContain('点下面的按钮，iPhone 会问你一次。以后按住“＋”就能直接说。');
    expect(screen.getByTestId('mic-card-main').textContent).toBe('允许麦克风');
    expect(screen.getByTestId('mic-card-alt').textContent).toBe('先只用打字');
    fireEvent.click(screen.getByTestId('mic-card-main'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onType).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mic-card-alt'));
    expect(onType).toHaveBeenCalledTimes(1);
  });

  it('被拒：主按钮“改用打字”→ onType，次按钮“我已打开，再试一次”→ onRetry', () => {
    show('denied');
    const dlg = screen.getByRole('dialog');
    expect(dlg.textContent).toContain('麦克风没有打开');
    expect(dlg.textContent).toContain('语音用不了。可以在 iPhone 的“设置”里给这个 App 打开麦克风。');
    expect(screen.getByTestId('mic-card-main').textContent).toBe('改用打字');
    expect(screen.getByTestId('mic-card-alt').textContent).toBe('我已打开，再试一次');
    fireEvent.click(screen.getByTestId('mic-card-main'));
    expect(onType).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('mic-card-alt'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('关着时不画', () => {
    render(<MicCard open={false} kind="ask" onOpenChange={onOpenChange} onRetry={onRetry} onType={onType} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('韩文', () => {
    uiStore.setState({ locale: 'ko-KR' });
    show('denied');
    expect(screen.getByTestId('mic-card-main').textContent).toBe('입력으로 기록');
    expect(screen.getByTestId('mic-card-alt').textContent).toBe('켰어요, 다시 시도');
  });
});

describe('MicCard 的图标和居中（负责人 11-10：按线框 s10）', () => {
  it.each(['ask', 'denied'] as const)('%s：卡顶有麦克风图标（读屏跳过），排在标题前面', (kind) => {
    show(kind);
    const dlg = screen.getByRole('dialog');
    const glyph = screen.getByTestId('mic-glyph');
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
    expect(dlg.firstElementChild?.contains(glyph)).toBe(true);
    expect(dlg.querySelector('h2')?.compareDocumentPosition(glyph)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    // 居中：内容区比默认多一个类
    expect(dlg.className.split(' ')).toHaveLength(2);
  });
});

describe('说明文字按设备分两套（R-367，负责人 11-10）', () => {
  it.each([
    ['ask', true, '点下面的按钮，iPhone 会问你一次。以后按住“＋”就能直接说。'],
    ['ask', false, '点下面的按钮，浏览器会问你一次。以后按住“＋”就能直接说。'],
    ['denied', true, '语音用不了。可以在 iPhone 的“设置”里给这个 App 打开麦克风。'],
    ['denied', false, '语音用不了。可以在浏览器的设置里给这个网站打开麦克风。'],
  ] as const)('%s · iOS=%s', (kind, isIos, text) => {
    ios = isIos;
    show(kind);
    expect(screen.getByRole('dialog').textContent).toContain(text);
    if (!isIos) expect(screen.getByRole('dialog').textContent).not.toContain('iPhone');
  });

  it.each([
    ['ask', '브라우저가 한 번 물어봐요'],
    ['denied', '브라우저 설정에서 이 사이트의 마이크를 켜 주세요'],
  ] as const)('韩文 %s · 非 iOS', (kind, part) => {
    ios = false;
    uiStore.setState({ locale: 'ko-KR' });
    show(kind);
    expect(screen.getByRole('dialog').textContent).toContain(part);
    expect(screen.getByRole('dialog').textContent).not.toContain('iPhone');
  });
});

