// 打字条收起的几条路（ui/TypeBar.tsx 的 useSettle / settle(reason)；剩余功能推进计划 11-13 第 8 节 前端-17）：
// 收起按钮、Esc、下滑把手、点空白（没打字）、记下后自动收起、判成别的意图、查找、展开编辑、换页（App 直接卸掉）各自的
// 收键盘、草稿、onClose / onExpand、提示条还在时只收打字条、运行日志 typebar settle reason=（只记由来，不记字）。
// 草稿只看“这次打过字没有”：同一份草稿 'capture:type' 录音、quick-add、结果层也在写，没打过字的收起不能拿空串删掉它；
// 收起后再展开（再点“＋”、结果层点“改”）重读草稿。草稿换成内存里的一份（data/type-draft.ts 的桩），查找那一块是别的功能，替身只记 openAssist
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import type { WriteResult } from '../../../core/write.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { UNDO_TOAST_MS } from '../../../kit/components/UndoToast.tsx';
import { clock } from '../../../platform/clock.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import type { Writer } from '../data/capture-save.ts';
import type * as Draft from '../data/type-draft.ts';
import TypeBar, { SWIPE_CLOSE_PX } from '../ui/TypeBar.tsx';
import type * as Session from '../../../platform/session.ts';

const SID = 'sid-t';
vi.mock('../../../platform/session.ts', async (orig) => ({ ...(await orig<typeof Session>()), readSessionId: () => SID }));

/** 内存里的那一份草稿：write 记下每次打字条自己写的字（空串即删，和真的一样），assist 是结果层、录音写的 */
const fx = vi.hoisted(() => ({
  draft: null as { text: string; assist?: true } | null,
  write: [] as string[],
  clear: 0,
  read: null as Promise<void> | null,
  open: vi.fn(),
}));
vi.mock('../data/type-draft.ts', async (orig) => ({
  ...(await orig<typeof Draft>()),
  readTypeDraft: async () => {
    if (fx.read) await fx.read;
    return fx.draft && fx.draft.text !== '' ? { text: fx.draft.text, day: null } : null;
  },
  writeTypeDraft: async (d: { text: string }) => {
    fx.write.push(d.text);
    fx.draft = d.text.trim() === '' ? null : { text: d.text };
  },
  clearTypeDraft: async () => {
    fx.clear += 1;
    fx.draft = null;
  },
  writeAssistDraft: async (d: { text: string }) => {
    fx.draft = { text: d.text, assist: true };
  },
}));
vi.mock('../../smart-search/index.ts', () => ({ loadFindOpen: async () => ({ openAssist: fx.open }), AssistPeek: () => null }));

const NOW = msAt('2026-11-02', 12 * 60, 'UTC');
const OK: WriteResult = { ok: true, item: null };

const lines: string[] = [];
const slots = globalThis as unknown as Record<string, unknown>;

interface Ui {
  n?: number;
  onClose?: () => void;
  onExpand?: (t: string, d: string | null) => void;
  day?: string | null;
  insert?: Writer['insert'];
}
function ui(o: Ui = {}) {
  const writer = { insert: vi.fn<Writer['insert']>(o.insert ?? (async () => OK)), patch: vi.fn<Writer['patch']>(async () => OK) };
  return <TypeBar day={o.day ?? null} writer={writer} online={() => true} opened={o.n ?? 1} onExpand={o.onExpand ?? vi.fn()} onClose={o.onClose ?? vi.fn()} />;
}

const input = (): HTMLInputElement => screen.getByTestId('type-input') as HTMLInputElement;
const type = (v: string): void => void fireEvent.change(input(), { target: { value: v } });
const settles = (): string[] => lines.filter((l) => l.startsWith('typebar settle'));
const submit = async (): Promise<void> => {
  await act(async () => {
    fireEvent.submit(screen.getByTestId('type-bar'));
    await Promise.resolve();
  });
};
/** 提示条满 8 秒到时（假时钟） */
const toastEnds = async (): Promise<void> => {
  await act(async () => vi.advanceTimersByTime(UNDO_TOAST_MS));
  await act(async () => vi.advanceTimersByTime(0));
};

/** 各条路怎么触发 */
const HOW = {
  button: () => fireEvent.click(screen.getByRole('button', { name: '收起' })),
  esc: () => fireEvent.keyDown(input(), { key: 'Escape' }),
  swipe: () => {
    const grip = screen.getByTestId('type-bar').firstElementChild as HTMLElement;
    fireEvent.pointerDown(grip, { clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(grip, { clientY: 100 + SWIPE_CLOSE_PX, pointerId: 1 });
  },
} as const;

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  uiStore.getState().setLocale('zh-CN');
  fx.draft = null;
  fx.write = [];
  fx.clear = 0;
  fx.read = null;
  fx.open.mockReset();
  lines.length = 0;
  slots[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete slots[RL_SLOT];
});

describe('打字条收起：收起按钮、Esc、下滑（打过字留草稿再关）', () => {
  for (const reason of ['button', 'esc', 'swipe'] as const) {
    it(`${reason}：收键盘、已打的字留草稿、再 onClose；日志只记由来`, async () => {
      const onClose = vi.fn();
      render(ui({ onClose }));
      type('买牛奶');
      expect(document.activeElement).toBe(input());
      const el = input();
      await act(async () => HOW[reason]());
      expect(document.activeElement).not.toBe(el);
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(fx.write).toEqual(['买牛奶']);
      expect(fx.clear).toBe(0);
      expect(settles()).toEqual([`typebar settle reason=${reason} fold=0`]);
      expect(lines.join(' ')).not.toContain('牛奶');
    });
  }

  it('下滑不到 SWIPE_CLOSE_PX 不收起', async () => {
    const onClose = vi.fn();
    render(ui({ onClose }));
    const grip = screen.getByTestId('type-bar').firstElementChild as HTMLElement;
    fireEvent.pointerDown(grip, { clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(grip, { clientY: 100 + SWIPE_CLOSE_PX - 1, pointerId: 1 });
    await act(async () => undefined);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('type-bar')).toBeTruthy();
  });

  it('打了字又删光：照样写（空串 = 用户自己清掉了，删草稿）', async () => {
    fx.draft = { text: '旧的' };
    render(ui());
    await waitFor(() => expect(input().value).toBe('旧的'));
    type('');
    await act(async () => HOW.button());
    expect(fx.write).toEqual(['']);
    expect(fx.draft).toBeNull();
  });

  it('连点两下收起：只关一次，第二下只记 skip', async () => {
    const onClose = vi.fn();
    render(ui({ onClose }));
    type('买');
    await act(async () => {
      HOW.button();
      HOW.esc();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fx.write).toEqual(['买']);
    expect(settles()).toEqual(['typebar settle reason=button fold=0', 'typebar settle skip reason=esc']);
  });
});

describe('打字条收起：没打过字不碰草稿（录音、quick-add、结果层写的那一份）', () => {
  it('没打字点空白：等同收起、onClose，不写草稿，已有的草稿留着', async () => {
    fx.draft = { text: '录音交来的', assist: true };
    fx.read = new Promise(() => undefined); // 还没读回来
    const onClose = vi.fn();
    render(ui({ onClose }));
    await act(async () => fireEvent.click(screen.getByTestId('type-mist')));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fx.write).toEqual([]);
    expect(fx.draft).toEqual({ text: '录音交来的', assist: true });
    expect(settles()).toEqual(['typebar settle reason=blank fold=0']);
  });

  it('草稿还没读回来就收起：不写，草稿留着，下次打开照样填回', async () => {
    fx.draft = { text: '上次的' };
    let back!: () => void;
    fx.read = new Promise<void>((r) => (back = r));
    const onClose = vi.fn();
    const r = render(ui({ onClose }));
    await act(async () => HOW.button());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fx.write).toEqual([]);
    await act(async () => back());
    r.unmount();
    fx.read = null;
    render(ui());
    await waitFor(() => expect(input().value).toBe('上次的'));
  });

  it('填回的草稿没改就收起：不写（不把原来的 assist 草稿改成普通草稿）', async () => {
    fx.draft = { text: '找牙医', assist: true };
    render(ui());
    await waitFor(() => expect(input().value).toBe('找牙医'));
    await act(async () => HOW.esc());
    expect(fx.write).toEqual([]);
    expect(fx.draft).toEqual({ text: '找牙医', assist: true });
  });

  it('打了字点空白：只收键盘，不算收起（不写草稿、不 onClose、不记 settle）', async () => {
    const onClose = vi.fn();
    render(ui({ onClose }));
    type('买菜');
    await act(async () => fireEvent.click(screen.getByTestId('type-mist')));
    expect(document.activeElement).not.toBe(input());
    expect(onClose).not.toHaveBeenCalled();
    expect(fx.write).toEqual([]);
    expect(settles()).toEqual([]);
  });
});

describe('打字条收起：展开编辑', () => {
  it('清草稿、把字和日子交给 onExpand；不调 onClose、不留草稿', async () => {
    const onExpand = vi.fn();
    const onClose = vi.fn();
    render(ui({ onExpand, onClose, day: '2026-11-20' }));
    type('开会');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '展开编辑' })));
    expect(onExpand).toHaveBeenCalledWith('开会', '2026-11-20');
    expect(fx.clear).toBe(1);
    expect(fx.write).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(settles()).toEqual(['typebar settle reason=expand fold=0']);
  });

  it('展开以后 App 把打字条卸掉：不再按“换页”留草稿', async () => {
    const r = render(ui({ onExpand: vi.fn() }));
    type('开会');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '展开编辑' })));
    r.unmount();
    expect(fx.write).toEqual([]);
    expect(settles()).toEqual(['typebar settle reason=expand fold=0']);
  });
});

describe('打字条收起：判成查找、交给结果层（handOff）', () => {
  it('查找：原话进草稿（toAssist 写的 assist 草稿），收键盘、onClose；打字条自己不再写草稿', async () => {
    const onClose = vi.fn();
    render(ui({ onClose }));
    type('帮我找牙医的记录');
    await submit();
    await waitFor(() => expect(fx.open).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fx.draft).toEqual({ text: '帮我找牙医的记录', assist: true });
    expect(fx.write).toEqual([]);
    expect(settles()).toEqual(['typebar settle reason=find fold=0']);
  });

  it('总结（planText 判成别的意图）：同上，日志 reason=asked', async () => {
    const onClose = vi.fn();
    render(ui({ onClose }));
    type('总结一下这周的随手记');
    await submit();
    await waitFor(() => expect(fx.open).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fx.draft).toEqual({ text: '总结一下这周的随手记', assist: true });
    expect(fx.write).toEqual([]);
    expect(settles()).toEqual(['typebar settle reason=asked fold=0']);
  });
});

describe('打字条收起：记下后自动收起、提示条还在时只收打字条', () => {
  const saveOne = async (): Promise<void> => {
    type('明天下午3点去银行办理业务');
    await submit();
  };

  it('记下后自动收起：只收打字条（fold=1），提示条满 8 秒才真正 onClose；字已经存了，不写草稿', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onClose = vi.fn();
    render(ui({ onClose }));
    await saveOne();
    expect(screen.queryByTestId('type-bar')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await toastEnds();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fx.write).toEqual([]);
    expect(settles()).toEqual(['typebar settle reason=saved fold=1', 'typebar settle reason=saved fold=end']);
  });

  it('提示条那 8 秒里录了一句写成 assist 草稿：提示条到时收尾不删它', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onClose = vi.fn();
    render(ui({ onClose }));
    await saveOne();
    fx.draft = { text: '录音判成查找的那句', assist: true };
    await toastEnds();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fx.draft).toEqual({ text: '录音判成查找的那句', assist: true });
  });

  it('提示条在时 Esc（打了字）：只收打字条，字留在状态里；提示条没了才留草稿、onClose', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onClose = vi.fn();
    const r = render(ui({ onClose, n: 1 }));
    await saveOne();
    act(() => r.rerender(ui({ onClose, n: 2 })));
    type('买菜');
    await act(async () => HOW.esc());
    expect(screen.queryByTestId('type-bar')).toBeNull();
    await toastEnds();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fx.write).toEqual(['买菜']);
    expect(settles().slice(-2)).toEqual(['typebar settle reason=esc fold=1', 'typebar settle reason=esc fold=end']);
  });

  it('提示条在时判成查找：只收打字条；提示条没了 onClose，toAssist 写的原话草稿不被删', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onClose = vi.fn();
    const r = render(ui({ onClose, n: 1 }));
    await saveOne();
    act(() => r.rerender(ui({ onClose, n: 2 })));
    type('帮我找牙医的记录');
    await submit();
    expect(screen.queryByTestId('type-bar')).toBeNull();
    await toastEnds();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fx.write).toEqual([]);
    expect(fx.draft).toEqual({ text: '帮我找牙医的记录', assist: true });
    expect(settles().slice(-2)).toEqual(['typebar settle reason=find fold=1', 'typebar settle reason=find fold=end']);
  });

  it('提示条在时判成查找、结果层点“改”（再打开，opened 变了）：重新展开时重读草稿，原话回到输入条', async () => {
    const r = render(ui({ n: 1 }));
    await saveOne();
    act(() => r.rerender(ui({ n: 2 })));
    type('帮我找牙医的记录');
    await submit();
    expect(screen.queryByTestId('type-bar')).toBeNull();
    // 结果层“改”：assist-open 写好草稿再调 App 的 open（opened 加 1）
    act(() => r.rerender(ui({ n: 3 })));
    await waitFor(() => expect(input().value).toBe('帮我找牙医的记录'));
  });

  it('提示条在时收起了、又再点“＋”：这次打过的字还在状态里，不被草稿覆盖', async () => {
    const r = render(ui({ n: 1 }));
    await saveOne();
    act(() => r.rerender(ui({ n: 2 })));
    type('买菜');
    await act(async () => HOW.esc());
    fx.draft = { text: '录音写的', assist: true };
    act(() => r.rerender(ui({ n: 3 })));
    await act(async () => undefined);
    expect(input().value).toBe('买菜');
  });
});

describe('打字条收起：换页（App 直接卸掉打字条）', () => {
  it('打了字：卸掉时留草稿，日志 reason=route；不调 onClose（App 已经关了）', () => {
    const onClose = vi.fn();
    const r = render(ui({ onClose }));
    type('买牛奶');
    r.unmount();
    expect(fx.write).toEqual(['买牛奶']);
    expect(onClose).not.toHaveBeenCalled();
    expect(settles()).toEqual(['typebar settle reason=route fold=0']);
  });

  it('没打字：卸掉时直接返回，不写草稿、不记日志', () => {
    fx.draft = { text: '别人写的', assist: true };
    const r = render(ui());
    r.unmount();
    expect(fx.write).toEqual([]);
    expect(fx.draft).toEqual({ text: '别人写的', assist: true });
    expect(settles()).toEqual([]);
  });

  it('StrictMode 挂上又卸又挂：不算收起，不写草稿、不记 settle，草稿照样填回', async () => {
    fx.draft = { text: '上次的' };
    render(<StrictMode>{ui()}</StrictMode>);
    await waitFor(() => expect(input().value).toBe('上次的'));
    expect(fx.write).toEqual([]);
    expect(settles()).toEqual([]);
    expect(fx.draft).toEqual({ text: '上次的' });
  });

  it('已经收起并 onClose 过的：App 再卸掉不重复留草稿、不记 skip', async () => {
    const onClose = vi.fn();
    const r = render(ui({ onClose }));
    type('买');
    await act(async () => HOW.button());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    r.unmount();
    expect(fx.write).toEqual(['买']);
    expect(settles()).toEqual(['typebar settle reason=button fold=0']);
  });

  it('提示条在时收起（打了字）、还没到时就换页：卸掉时把字留成草稿', async () => {
    const r = render(ui({ n: 1 }));
    type('明天下午3点去银行办理业务');
    await submit();
    act(() => r.rerender(ui({ n: 2 })));
    type('买菜');
    await act(async () => HOW.esc());
    expect(screen.queryByTestId('type-bar')).toBeNull();
    r.unmount();
    expect(fx.write).toEqual(['买菜']);
    expect(settles().slice(-2)).toEqual(['typebar settle reason=esc fold=1', 'typebar settle reason=route fold=0']);
  });

  it('记下后自动收起、还没到时就换页：字已经存了，不写草稿、不记日志', async () => {
    const r = render(ui());
    type('明天下午3点去银行办理业务');
    await submit();
    expect(screen.queryByTestId('type-bar')).toBeNull();
    r.unmount();
    expect(fx.write).toEqual([]);
    expect(settles()).toEqual(['typebar settle reason=saved fold=1']);
  });
});

describe('打字条收起：整理中点收起、之后才存好', () => {
  it('收起时留草稿、onClose；存好以后自动收起只记 skip，不再关一次', async () => {
    let land!: () => void;
    const insert = vi.fn<Writer['insert']>(() => new Promise<WriteResult>((ok) => (land = () => ok(OK))));
    const onClose = vi.fn();
    render(ui({ onClose, insert }));
    type('明天下午3点去银行办理业务');
    await submit();
    await waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('type-preview').textContent).toBe('正在识别…');
    await act(async () => HOW.button());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fx.write).toEqual(['明天下午3点去银行办理业务']);
    await act(async () => {
      land();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId('type-notice')).toBeTruthy();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fx.draft, '存好了，草稿清掉').toBeNull();
    expect(settles()).toEqual(['typebar settle reason=button fold=0', 'typebar settle skip reason=saved']);
  });
});
