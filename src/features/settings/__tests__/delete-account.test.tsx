// 设置 › 账号 › 注销账号的界面（R-188、R-192、R-256 ⑤；TC-B1-95 的界面部分、TC-B1-98 申请那台的客户端部分）
// 中文、韩文界面都用真词典（确认词“注销”“탈퇴”要跟着语言变）
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import { COOLING_MS } from '../ui/DeleteAccountView.tsx';
import { fmtWhen } from '../ui/DevicesSection.tsx';
import { fakeAccount, setOnline, setup } from './account-fakes.tsx';
import { NOW, text } from './fakes.tsx';

beforeEach(() => {
  uiStore.getState().setLocale('zh-CN');
  setOnline(true);
});
afterEach(() => {
  cleanup();
  setOnline(true);
});

async function openDelete(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('settings-delete-entry'));
  });
  await screen.findByTestId('settings-delete');
}

const input = (): HTMLInputElement => screen.getByTestId('settings-delete-input') as HTMLInputElement;
const submitBtn = (): HTMLButtonElement => screen.getByTestId('settings-delete-submit') as HTMLButtonElement;
const type = (v: string): void => void fireEvent.change(input(), { target: { value: v } });

describe('注销账号（设置 › 账号 › 注销账号）', () => {
  it('正文四句：会删什么、7 天冷静期（日期 + 时刻）、满 7 天不能恢复、只发邮件；只有一个输入框，没有验证码框', async () => {
    setup();
    await openDelete();
    const page = screen.getByTestId('settings-delete');
    expect(text(page)).toContain(zh['settings.delete.body.what']);
    expect(text(screen.getByTestId('settings-delete-cooling'))).toContain(fmtWhen(NOW + COOLING_MS, 'zh-CN'));
    expect(text(page)).toContain(zh['settings.delete.body.final']);
    expect(text(page)).toContain(zh['settings.delete.body.mail']);
    expect(within(page).getAllByRole('textbox')).toHaveLength(1);
    expect(within(page).getByLabelText('请输入“注销”确认')).toBe(input());
    expect(text(submitBtn())).toBe('注销账号');
    // 返回设置首页（退回上一条历史，不再 push 一条“设置”）
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-delete-back'));
    });
    await waitFor(() => expect(screen.queryByTestId('settings-delete')).toBeNull());
    expect(screen.getByTestId('settings-export')).toBeTruthy();
    expect(window.location.hash).toBe('#/settings');
  });

  it('注销页有自己的地址（负责人 10-30“注销页左滑应该回设置”）：点入口 push #/settings/delete，侧滑（history.back）回设置首页', async () => {
    setup();
    await openDelete();
    expect(window.location.hash).toBe('#/settings/delete');
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(screen.queryByTestId('settings-delete')).toBeNull());
    expect(window.location.hash).toBe('#/settings');
    expect(screen.getByTestId('settings-delete-entry')).toBeTruthy();
  });

  it('直接打开 #/settings/delete（没有从设置点进来）：显示注销页；“‹ 返回”原地换成设置首页、不多压一条历史', async () => {
    setup({ hash: '#/settings/delete' });
    const before = window.history.length;
    await screen.findByTestId('settings-delete');
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-delete-back'));
    });
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    expect(screen.queryByTestId('settings-delete')).toBeNull();
    expect(window.history.length).toBe(before);
  });

  it('有没上传的：提示“还有 N 条改动没上传，注销后会丢弃”（和退出登录确认框同一个计数）；0 条不提示；数不出来写“可能有”', async () => {
    const a = setup({ pending: 3 });
    await openDelete();
    expect(text(await screen.findByTestId('settings-delete-unsent'))).toBe('还有 3 条改动没上传，注销后会丢弃');
    expect(a.exit.pendingCount).toHaveBeenCalledTimes(1);
    cleanup();
    setup({ pending: 0 });
    await openDelete();
    await waitFor(() => expect(screen.queryByTestId('settings-delete-unsent')).toBeNull());
    cleanup();
    setup({ pending: null });
    await openDelete();
    expect(text(await screen.findByTestId('settings-delete-unsent'))).toBe(zh['settings.delete.unsentUnknown']);
  });

  it('中文界面：不填、“注消”、“탈퇴”都不可提交；“ 注销 ”（前后空格）可提交；组字中途不可提交，compositionend 后再判断', async () => {
    setup();
    await openDelete();
    expect(submitBtn().disabled).toBe(true);
    for (const v of ['注消', '탈퇴', '注 销', '注销账号']) {
      type(v);
      expect(submitBtn().disabled, v).toBe(true);
    }
    type(' 注销 ');
    expect(submitBtn().disabled).toBe(false);
    // 输入法组字：开始后哪怕框里已经是“注销”也不可点，组完才可点
    type('');
    fireEvent.compositionStart(input());
    type('注销');
    expect(submitBtn().disabled).toBe(true);
    fireEvent.compositionEnd(input());
    expect(submitBtn().disabled).toBe(false);
  });

  it('韩文界面：确认词是“탈퇴”，打“注销”不可提交', async () => {
    uiStore.getState().setLocale('ko-KR');
    setup();
    await openDelete();
    expect(text(submitBtn())).toBe(ko['settings.delete.submit']);
    type('注销');
    expect(submitBtn().disabled).toBe(true);
    type('탈퇴 ');
    expect(submitBtn().disabled).toBe(false);
  });

  it('提交：发去掉首尾空白的确认词；成功后不调 signOut、不删 devices 行，按发请求的会话离开本机（冷静期提示）', async () => {
    const { account, leave, api, exit } = setup();
    await openDelete();
    type(' 注销 ');
    await act(async () => {
      fireEvent.submit(input().form as HTMLFormElement);
    });
    expect(account.requestDeletion).toHaveBeenCalledWith('注销');
    // 服务器已在同一事务里吊销全部会话：revoked: true，照旧删本机会话（R-262 的例外）
    expect(leave).toHaveBeenCalledWith('pending_deletion', 's-me', { revoked: true });
    expect(api.dropLocalSession).not.toHaveBeenCalled();
    expect(api.deleteOwnDevice).not.toHaveBeenCalled();
    expect(exit.wipe).not.toHaveBeenCalled();
    // 跳走之前一直是“正在注销”，不能再提交
    expect(submitBtn().disabled).toBe(true);
    expect(text(screen.getByTestId('settings-delete'))).toContain(zh['settings.delete.busy']);
  });

  it('组字中途按回车不提交', async () => {
    const { account } = setup();
    await openDelete();
    fireEvent.compositionStart(input());
    type('注销');
    await act(async () => {
      fireEvent.submit(input().form as HTMLFormElement);
    });
    expect(account.requestDeletion).not.toHaveBeenCalled();
  });

  it('错误：confirm_required 提示照着输入；管理员提示去控制台；rate_limited 提示今天合计 3 次用完；提示后能再提交', async () => {
    for (const [error, want] of [
      ['confirm_required', '请照着输入“注销”'],
      ['admin_cannot_delete', zh['settings.delete.admin']],
      ['rate_limited', zh['settings.account.rateLimited']],
      ['try_later', zh['settings.err.tryLater']],
      ['offline', zh['settings.err.offline']],
    ] as const) {
      const account = fakeAccount({ requestDeletion: vi.fn(async () => ({ ok: false as const, error, sid: 's-me' })) });
      const { leave } = setup({ account });
      await openDelete();
      type('注销');
      await act(async () => {
        fireEvent.click(submitBtn());
      });
      expect(text(await screen.findByRole('alert')), error).toBe(want);
      expect(leave).not.toHaveBeenCalled();
      expect(submitBtn().disabled).toBe(false);
      cleanup();
    }
  });

  it('注销时发现已在冷静期（别的设备刚申请过）：照样清本机、回登录页带冷静期提示', async () => {
    const account = fakeAccount({ requestDeletion: vi.fn(async () => ({ ok: false as const, error: 'pending_deletion' as const, sid: 's-me' })) });
    const { leave } = setup({ account });
    await openDelete();
    type('注销');
    await act(async () => {
      fireEvent.click(submitBtn());
    });
    expect(leave).toHaveBeenCalledWith('pending_deletion', 's-me');
  });
});
