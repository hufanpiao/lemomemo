// 打字条（ui/TypeBar.tsx、hooks/useTypeBar.ts；B3 任务单 S2、FA-2；R-166、R-353）。写入用桩，不调 AI
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import type { WriteResult } from '../../../core/write.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import type { Writer } from '../data/capture-save.ts';
import TypeBar from '../ui/TypeBar.tsx';

const NOW = msAt('2026-11-02', 10 * 60, 'Asia/Seoul');
const OK: WriteResult = { ok: true, item: null };
/** 写入桩第 n 次调用的数据里某个字段 */
const field = (v: unknown, k: string): unknown => (v as Record<string, unknown> | undefined)?.[k];

function setup(over: { day?: string | null; insert?: Writer['insert']; online?: boolean } = {}) {
  const writer = { insert: vi.fn<Writer['insert']>(over.insert ?? (async () => OK)), patch: vi.fn<Writer['patch']>(async () => OK) };
  const onExpand = vi.fn();
  const onClose = vi.fn();
  render(<TypeBar day={over.day ?? null} writer={writer} online={() => over.online ?? true} onExpand={onExpand} onClose={onClose} />);
  return { writer, onExpand, onClose, input: screen.getByTestId('type-input') };
}

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  uiStore.getState().setLocale('zh-CN');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('打字条', () => {
  it('打开就聚焦；边打边预览“会记成这样”（本机规则）', () => {
    const { input } = setup();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '明天下午3点去银行办理业务' } });
    expect(screen.getByTestId('type-preview').textContent).toBe('会记成这样：日程 · 去银行办理业务 · 11-03 15:00');
  });

  it('回车保存：经写入口进 outbox，输入框清空，出“已记下 · 撤销”；撤销写 undone', async () => {
    const { input, writer } = setup();
    fireEvent.change(input, { target: { value: '明天下午3点去银行办理业务' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(writer.insert.mock.calls[0]?.[0]).toBe('events');
    expect(writer.insert.mock.calls[0]?.[1]).toMatchObject({ title: '去银行办理业务', date: '2026-11-03', time: '15:00', source: 'page', raw_text: '明天下午3点去银行办理业务' });
    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('type-notice').textContent).toContain('已记下：去银行办理业务');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    });
    expect(writer.patch).toHaveBeenCalledWith('events', expect.any(String), { undone: true, updated_at: NOW });
  });

  it('S24 Ctrl+Z：提示条还在、输入框空着时撤销这一批；输入框有字时让给浏览器撤销打字；没有提示条时不管', async () => {
    const { input, writer } = setup();
    const ctrlZ = (): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(e);
      return e;
    };
    expect(ctrlZ().defaultPrevented, '还没记下，不管').toBe(false);
    fireEvent.change(input, { target: { value: '明天下午3点去银行办理业务' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
    fireEvent.change(input, { target: { value: '买' } });
    expect(ctrlZ().defaultPrevented, '有字：让给浏览器').toBe(false);
    expect(writer.patch).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '' } });
    let e!: KeyboardEvent;
    await act(async () => {
      e = ctrlZ();
    });
    expect(e.defaultPrevented).toBe(true);
    expect(writer.patch).toHaveBeenCalledWith('events', expect.any(String), { undone: true, updated_at: NOW });
  });

  it('没写进去：提示“没保存上”，原话留在输入框', async () => {
    const { input } = setup({ insert: async () => ({ ok: false, reason: 'local_unavailable' }) });
    fireEvent.change(input, { target: { value: '明天下午3点去银行办理业务' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
    expect(screen.getByRole('alert').textContent).toBe('没保存上，原话还在输入框里');
    expect((input as HTMLInputElement).value).toBe('明天下午3点去银行办理业务');
  });

  it('离线：已存在手机里', async () => {
    const { input } = setup({ online: false });
    fireEvent.change(input, { target: { value: '买牛奶' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
    expect(screen.getByTestId('type-notice').textContent).toContain('没网，已存在手机里：买牛奶');
  });

  it('R-166：过去的月日先出确认行，选了才保存；关掉确认行原话还在', async () => {
    const { input, writer } = setup();
    fireEvent.change(input, { target: { value: '10月30号下午两点和客户开会' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
    expect(writer.insert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect((screen.getByTestId('type-input') as HTMLInputElement).value).toBe('10月30号下午两点和客户开会');
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '明年（2027/10/30）' }));
    });
    expect(writer.insert.mock.calls[0]?.[1]).toMatchObject({ date: '2027-10-30', time: '14:00' });
  });

  it('多条：“已记下 N 条”，展开逐条撤销；合并成一条；全部撤销', async () => {
    const writer = { insert: vi.fn<Writer['insert']>(async () => OK), patch: vi.fn<Writer['patch']>(async () => OK) };
    const onEdit = vi.fn();
    render(<TypeBar day={null} writer={writer} online={() => true} onExpand={vi.fn()} onEdit={onEdit} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('type-input'), { target: { value: '커피 원두 사기, 전기요금 내기, 수요일까지 NEOX에 견적서 보내기' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
    expect(writer.insert).toHaveBeenCalledTimes(3);
    const ids = writer.insert.mock.calls.map((c) => String(field(c[1], 'id')));
    const batch = field(writer.insert.mock.calls[0]?.[1], 'batch_id');
    expect(writer.insert.mock.calls.every((c) => field(c[1], 'batch_id') === batch)).toBe(true);
    expect(screen.getByTestId('type-notice').textContent).toContain('已记下 3 条');
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    fireEvent.click(screen.getByRole('button', { name: '修改：待办 · 커피 원두 사기' }));
    expect(onEdit).toHaveBeenCalledWith('todos', ids[0]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '撤销：待办 · 커피 원두 사기' }));
    });
    expect(writer.patch).toHaveBeenLastCalledWith('todos', ids[0], { undone: true, updated_at: NOW });
    expect(screen.getByTestId('type-notice').textContent).toContain('已记下 2 条');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '拆错了，合并成一条' }));
    });
    expect(writer.patch).toHaveBeenCalledTimes(3);
    expect(writer.insert).toHaveBeenCalledTimes(4);
    expect(writer.insert.mock.calls[3]?.[1]).toMatchObject({ title: '커피 원두 사기, 전기요금 내기, 수요일까지 NEOX에 견적서 보내기' });
    expect(field(writer.insert.mock.calls[3]?.[1], 'batch_id')).not.toBe(batch);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    });
    expect(writer.patch).toHaveBeenCalledTimes(4);
  });

  it('R-166：同一句里没问题的先存，过去日子那条选完加进同一批', async () => {
    const { input, writer } = setup();
    fireEvent.change(input, { target: { value: '明天下午3点去银行办理业务，10月30号下午两点和客户开会' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('type-confirm').textContent).toContain('10 月 30 日已经过了');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '补记今年（10/30）' }));
    });
    expect(writer.insert).toHaveBeenCalledTimes(2);
    const b = (n: number) => field(writer.insert.mock.calls[n]?.[1], 'batch_id');
    expect(b(1)).toBe(b(0));
    expect(writer.insert.mock.calls[1]?.[1]).toMatchObject({ date: '2026-10-30' });
    expect(screen.getByTestId('type-notice').textContent).toContain('已记下 2 条');
  });

  it('R-166 补充：同一句里先存了几条，确认行没选就关掉：输入条只留等确认那条的原文；去不干净时原话整句留着并提示', async () => {
    const { input, writer } = setup();
    fireEvent.change(input, { target: { value: '明天下午3点去银行办理业务，10月30号下午两点和客户开会' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
    expect(writer.insert).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect((screen.getByTestId('type-input') as HTMLInputElement).value).toBe('10月30号下午两点和客户开会');
    expect(screen.queryByTestId('type-part-saved')).toBeNull();
    expect(screen.getByTestId('type-notice').textContent).toContain('已记下：去银行办理业务');

    fireEvent.change(screen.getByTestId('type-input'), { target: { value: '买牛奶、10月30号交报告和明天开会' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('type-bar'));
    });
    expect(writer.insert).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect((screen.getByTestId('type-input') as HTMLInputElement).value).toBe('买牛奶、10月30号交报告和明天开会');
    expect(screen.getByTestId('type-part-saved').textContent).toBe('同一句里其他几条已经记下了');
    fireEvent.change(screen.getByTestId('type-input'), { target: { value: '10月30号交报告' } });
    expect(screen.queryByTestId('type-part-saved'), '一改字就收起').toBeNull();
  });

  it('R-353：“展开编辑”带上已打的字和选中的日子', () => {
    const { input, onExpand } = setup({ day: '2026-11-20' });
    fireEvent.change(input, { target: { value: '开会' } });
    fireEvent.click(screen.getByRole('button', { name: '展开编辑' }));
    expect(onExpand).toHaveBeenCalledWith('开会', '2026-11-20');
  });

  it('Esc / “收起”：留草稿后关', async () => {
    const { input, onClose } = setup();
    fireEvent.change(input, { target: { value: '买' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('韩文界面', () => {
    uiStore.getState().setLocale('ko-KR');
    setup();
    expect(screen.getByRole('button', { name: '자세히 편집' })).toBeTruthy();
  });
});
