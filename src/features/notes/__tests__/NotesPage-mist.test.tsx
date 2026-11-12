// 随手记输入框后面的整页模糊（R-401，负责人 11-13“随手记点输入框背景也要模糊”；kit Mist，和打字条 R-399 同一份）：
// 输入框有焦点才有这一层、各记一行运行日志；点这一层只让输入框失焦（输入行一直在），打的字留着
// 层级和后备样式在 plus/__tests__/TypeBar-mist.test.tsx；真浏览器里的模糊、层级、不点穿在 e2e r401-notes-mist.spec.ts
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { coldStart, getBoot, resetBootForTest } from '../../../core/boot.ts';
import { fakeIndexedDB } from '../../../core/__tests__/idb-fake.ts';
import { clearAllCollections } from '../../../core/store.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import NotesPage from '../ui/NotesPage.tsx';

const NOW = msAt('2026-11-13', 9 * 60, 'Asia/Seoul');
const slots = globalThis as unknown as Record<string, unknown>;
let lines: string[] = [];
const mistLines = (): string[] => lines.filter((l) => l.startsWith('notes mist'));

beforeEach(async () => {
  clearAllCollections();
  uiStore.getState().setLocale('zh-CN');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  lines = [];
  slots[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
  const { factory } = fakeIndexedDB();
  await coldStart({
    userId: 'A', appVersion: '4.0.0', cacheOptions: { factory }, listen426: false, clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  });
  window.history.replaceState(null, '', '/app/#/notes');
  render(<NotesPage />);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  getBoot()?.cache?.close();
  resetBootForTest();
  delete slots[RL_SLOT];
});

describe('随手记输入框后面的整页模糊（R-401）', () => {
  it('没聚焦时没有这一层；聚焦就出现（不进读屏、记一行 on），失焦就没（记一行 off）', () => {
    const input = screen.getByTestId('notes-input');
    expect(screen.queryByTestId('notes-mist')).toBeNull();
    fireEvent.focus(input);
    const mist = screen.getByTestId('notes-mist');
    expect(mist.getAttribute('aria-hidden')).toBe('true');
    expect(mistLines()).toEqual(['notes mist on fx=none']);
    fireEvent.blur(input);
    expect(screen.queryByTestId('notes-mist')).toBeNull();
    expect(mistLines()).toEqual(['notes mist on fx=none', 'notes mist off']);
  });

  it('点模糊处：输入框失焦（收键盘）、这一层没了；输入行还在，打的字留着', () => {
    const input = screen.getByTestId<HTMLInputElement>('notes-input');
    input.focus();
    fireEvent.change(input, { target: { value: '明天买牛奶' } });
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByTestId('notes-mist'));
    expect(document.activeElement).not.toBe(input);
    expect(screen.queryByTestId('notes-mist')).toBeNull();
    expect(screen.getByTestId<HTMLInputElement>('notes-input').value).toBe('明天买牛奶');
  });

  it('模糊层排在输入行前面（同一层叠上下文里，输入行靠层级压在它上面）', () => {
    fireEvent.focus(screen.getByTestId('notes-input'));
    const mist = screen.getByTestId('notes-mist');
    expect(mist.compareDocumentPosition(screen.getByTestId('notes-input-row')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
