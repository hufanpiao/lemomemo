// 设置 › 数据 › 导出全部的分片界面（架构 0.47 第 4～16 条，0.47 续 ④ 第 3、4 点、⑥ 前端第 2、3 项）：
// 常驻提示、进度“已取回 N MB”、中断后“继续 / 取消”（不再 start、不另算次数）、1 小时后过期、各种失败的提示、“最近的导出”的“未完成”
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type { AccountErr, AccountResult, ExportFile, ExportPart } from '../data/account-api.ts';
import { EXPORT_RESUME_MS } from '../data/export-run.ts';
import { zh } from '../i18n/zh.ts';
import { EXPORT_ID, exportBtn, fakeAccount, gzLike, setOnline, setup } from './account-fakes.tsx';
import { deferred, text } from './fakes.tsx';

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  setOnline(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setOnline(true);
});

const MB = 1048576;
const part = (bytes: number, next: string | null): AccountResult<ExportPart> => ({
  ok: true,
  value: { blob: gzLike(bytes), next, disposition: null, contentLength: bytes, contentEncoding: null },
});
const bad = (error: AccountErr): AccountResult<ExportPart> => ({ ok: false, error, sid: 's-me' });
const status = (): string => text(screen.getByTestId('settings-export-status'));
const progress = (mb: string): string => zh['settings.export.progress'].replace('{mb}', mb);
const click = async (el: Element): Promise<void> => {
  await act(async () => {
    fireEvent.click(el);
  });
};

describe('导出分片（设置 › 数据）', () => {
  it('按钮下常驻“每天合计 3 次、每点一次算一次”和“建议连 Wi-Fi”，合成一段；按钮的 aria-describedby 只指这一段', async () => {
    setup();
    const notes = screen.getByTestId('settings-export-notes');
    expect(text(notes)).toContain(zh['settings.export.quota']);
    expect(text(notes)).toContain(zh['settings.export.wifi']);
    expect(exportBtn().getAttribute('aria-describedby')).toBe(notes.id);
    expect(notes.tagName).toBe('P');
  });

  it('取片中屏幕上写“正在导出…已取回 N MB”、随每片更新；播报区（role=status）只在开头和取回第一片时变，中间不再播报；取完存一个文件', async () => {
    const second = deferred<AccountResult<ExportPart>>();
    const third = deferred<AccountResult<ExportPart>>();
    const takePart = vi.fn(async (_e: string, c: string | null) =>
      c === null ? part(Math.round(1.5 * MB), 'c1') : c === 'c1' ? second.promise : third.promise);
    const { save } = setup({ account: fakeAccount({ takePart }) });
    await click(exportBtn());
    const shown = (): string => text(screen.getByTestId('settings-export-progress'));
    await waitFor(() => expect(shown()).toBe(progress('1.5')));
    expect(status()).toBe(progress('1.5'));
    expect(screen.getByTestId('settings-export-progress').closest('[role="status"]')).toBeNull();
    expect(exportBtn().disabled).toBe(true);
    await act(async () => second.resolve(part(MB, 'c2')));
    await waitFor(() => expect(shown()).toBe(progress('2.5')));
    expect(status()).toBe(progress('1.5'));
    await act(async () => third.resolve(part(MB, null)));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const file = (save.mock.calls[0] as unknown as [ExportFile] | undefined)?.[0];
    expect(file?.blob.size).toBe(Math.round(3.5 * MB));
    expect(screen.queryByTestId('settings-export-progress')).toBeNull();
    expect(status()).toContain(zh['settings.export.done']);
  });

  it('中断：写“导出中断了…不另算次数”和已取回多少，给“继续”“取消”，焦点到“继续”；导出按钮不可点；“继续”用同一个任务和游标接着取、不再 start', async () => {
    let broken = true;
    const takePart = vi.fn(async (_e: string, c: string | null) => {
      if (c === null) return part(MB, 'c1');
      return broken ? bad('bad_response') : part(MB, null);
    });
    const account = fakeAccount({ takePart });
    const { save } = setup({ account });
    await click(exportBtn());
    await screen.findByTestId('settings-export-resume');
    expect(status()).toContain(zh['settings.export.paused']);
    expect(text(screen.getByTestId('settings-export-progress'))).toBe(progress('1.0'));
    expect(screen.getByTestId('settings-export-cancel')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId('settings-export-resume'));
    expect(exportBtn().disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    broken = false;
    await click(screen.getByTestId('settings-export-resume'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(account.startExport).toHaveBeenCalledTimes(1);
    expect(takePart.mock.calls.map((c) => [c[0], c[1]])).toEqual([[EXPORT_ID, null], [EXPORT_ID, 'c1'], [EXPORT_ID, 'c1']]);
    expect((save.mock.calls[0] as unknown as [ExportFile] | undefined)?.[0].blob.size).toBe(2 * MB);
    expect(screen.queryByTestId('settings-export-resume')).toBeNull();
  });

  it('明确的 4xx 码（bad_request、426 等，归成 unknown）：不自动重试、不给“继续”，按通用提示失败（TC-B1-126 ④）', async () => {
    const takePart = vi.fn(async () => bad('unknown'));
    setup({ account: fakeAccount({ takePart }) });
    await click(exportBtn());
    expect(text(await screen.findByRole('alert'))).toBe(zh['settings.err.unknown']);
    expect(takePart).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('settings-export-resume')).toBeNull();
  });

  it('导出途中进注销页再回来：任务挂在设置整页上，取片没停；中断的回来仍能“继续”，不抢焦点', async () => {
    let broken = true;
    const gate = deferred<AccountResult<ExportPart>>();
    const takePart = vi.fn(async (_e: string, c: string | null) => {
      if (c === null) return gate.promise;
      return broken ? bad('bad_response') : part(MB, null);
    });
    const account = fakeAccount({ takePart });
    const { save } = setup({ account });
    await click(exportBtn());
    await click(screen.getByTestId('settings-delete-entry'));
    await screen.findByTestId('settings-delete');
    expect(screen.queryByTestId('settings-export')).toBeNull();
    // 在注销页时第一片回来，第二片失败、停下
    await act(async () => gate.resolve(part(MB, 'c1')));
    await waitFor(() => expect(takePart).toHaveBeenCalledTimes(2));
    await click(screen.getByTestId('settings-delete-back'));
    await waitFor(() => expect(screen.queryByTestId('settings-delete')).toBeNull());
    const resume = await screen.findByTestId('settings-export-resume');
    expect(status()).toContain(zh['settings.export.paused']);
    expect(text(screen.getByTestId('settings-export-progress'))).toBe(progress('1.0'));
    expect(document.activeElement).not.toBe(resume);
    broken = false;
    await click(resume);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(account.startExport).toHaveBeenCalledTimes(1);
    expect(takePart.mock.calls.map((c) => c[1])).toEqual([null, 'c1', 'c1']);
  });

  it('断网时进入中断：“继续”不可点，焦点落到“取消”', async () => {
    const takePart = vi.fn(async () => {
      setOnline(false);
      return bad('bad_response');
    });
    setup({ account: fakeAccount({ takePart }) });
    await click(exportBtn());
    const resume = (await screen.findByTestId('settings-export-resume')) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('settings-export-cancel'));
  });

  it('断网时“继续”不可点', async () => {
    setup({ account: fakeAccount({ takePart: vi.fn(async () => bad('bad_response')) }) });
    await click(exportBtn());
    const resume = (await screen.findByTestId('settings-export-resume')) as HTMLButtonElement;
    act(() => setOnline(false));
    expect(resume.disabled).toBe(true);
  });

  it('“取消”：丢掉这次的进度，回到可以重新导出（重新导出会再 start 一次）', async () => {
    const account = fakeAccount({ takePart: vi.fn(async () => bad('bad_response')) });
    setup({ account });
    await click(exportBtn());
    await click(await screen.findByTestId('settings-export-cancel'));
    expect(screen.queryByTestId('settings-export-resume')).toBeNull();
    expect(status()).toBe('');
    expect(exportBtn().disabled).toBe(false);
    await click(exportBtn());
    expect(account.startExport).toHaveBeenCalledTimes(2);
  });

  it('中断后满 1 小时：自动换成“这次导出已过期，请重新导出（会算一次）”，不再给“继续”', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup({ account: fakeAccount({ takePart: vi.fn(async () => bad('bad_response')) }) });
    await click(exportBtn());
    await screen.findByTestId('settings-export-resume');
    await act(async () => vi.advanceTimersByTimeAsync(EXPORT_RESUME_MS));
    expect(text(screen.getByRole('alert'))).toBe(zh['settings.export.expired']);
    expect(screen.queryByTestId('settings-export-resume')).toBeNull();
    expect(exportBtn().disabled).toBe(false);
  });

  it('分片失败的提示：410 过期、413 数据异常、part 的 rate_limited 是“今天导出的次数用完了”（start 的 rate_limited 仍是每天 3 次）', async () => {
    for (const [error, want] of [
      ['export_expired', zh['settings.export.expired']],
      ['export_too_large', zh['settings.export.tooLarge']],
      ['rate_limited', zh['settings.export.partsUsedUp']],
    ] as const) {
      const { leave } = setup({ account: fakeAccount({ takePart: vi.fn(async () => bad(error)) }) });
      await click(exportBtn());
      expect(text(await screen.findByRole('alert')), error).toBe(want);
      expect(screen.queryByTestId('settings-export-resume')).toBeNull();
      expect(leave).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('start 回 export_too_large（大小预检拒了、不扣次数，0.47 续 ①“超大账号”）：提示“超过一次导出的上限”，不说次数，不取片、不重读最近的导出；part 回同一个码仍是原来的提示', async () => {
    const takePart = vi.fn(async () => part(1, null));
    const account = fakeAccount({ startExport: vi.fn(async () => ({ ok: false as const, error: 'export_too_large' as const, sid: 's-me' })), takePart });
    const { recentExports, leave } = setup({ account });
    await waitFor(() => expect(recentExports.list).toHaveBeenCalledTimes(1));
    await click(exportBtn());
    const msg = text(await screen.findByRole('alert'));
    expect(msg).toBe(zh['settings.export.tooLargeStart']);
    expect(msg).not.toBe(zh['settings.export.tooLarge']);
    // 不说扣次数、用完次数（“一次导出”里的“次”是量词，不算）
    for (const w of ['3 次', '算一次', '用完', '次数']) expect(msg).not.toContain(w);
    expect(screen.queryByText(zh['settings.account.rateLimited'])).toBeNull();
    expect(takePart).not.toHaveBeenCalled();
    expect(screen.queryByTestId('settings-export-resume')).toBeNull();
    expect(exportBtn().disabled).toBe(false);
    expect(leave).not.toHaveBeenCalled();
    expect(recentExports.list).toHaveBeenCalledTimes(1);
  });

  it('取片中会话没了：走“被移除”流程，不给“继续”', async () => {
    const a = setup({ account: fakeAccount({ takePart: vi.fn(async () => bad('revoked')) }) });
    await click(exportBtn());
    await screen.findByRole('dialog');
    await waitFor(() => expect(a.exit.wipe).toHaveBeenCalled());
    expect(screen.queryByTestId('settings-export-resume')).toBeNull();
  });
});

describe('最近的导出：未完成', () => {
  it('没配上 export_done 的那次标“未完成”，其余不标', async () => {
    const T = Date.parse('2026-10-29T03:00:00Z');
    setup({
      recent: async () => ({
        kind: 'ready',
        list: [
          { at: T, device: 'y', mailFailed: false, incomplete: true },
          { at: T - 3_600_000, device: 'y', mailFailed: false, incomplete: false },
        ],
      }),
    });
    await screen.findByTestId('settings-recent-export');
    const rows = screen.getAllByTestId('settings-recent-export-row');
    expect(text(rows[0])).toContain(zh['settings.recentExport.incomplete']);
    expect(text(rows[1])).not.toContain(zh['settings.recentExport.incomplete']);
    expect(screen.getAllByTestId('settings-recent-export-incomplete')).toHaveLength(1);
  });
});
