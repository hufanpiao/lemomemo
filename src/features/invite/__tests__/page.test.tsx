// 设置 › 邀请朋友（R-83、架构 5.6）：备注说明、生成、刚生成的码 4 位一组和复制（复制不了就选中）、列表、出错话、防连点；
// 作废（负责人 11-27）：还没用的才有按钮、页面里的确认框问一次、确认了才发、作废的那行从列表拿掉；运行日志里没有邀请码、备注和行的 id
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type * as Api from '../data/invite-api.ts';
import { zh } from '../i18n/zh.ts';

const api = { createInvite: vi.fn(), listInvites: vi.fn(), revokeInvite: vi.fn() };
vi.mock('../data/invite-api.ts', async (orig) => ({
  ...(await orig<typeof Api>()),
  createInvite: (note: string) => api.createInvite(note),
  listInvites: () => api.listInvites(),
  revokeInvite: (id: string) => api.revokeInvite(id),
}));
const logs: string[] = [];
vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: (s: string) => logs.push(s) }));
const { default: InviteSettings } = await import('../ui/InviteSettings.tsx');

const CODE = 'K7Q2M9XD4TPA';
const NOTE = '10-29';
const ROWS = [
  { id: 'aaaa0001', note: '3 号', max_uses: 1, used_count: 1, expires_at: '2026-12-01T03:00:00+00:00' },
  { id: 'bbbb0002', note: null, max_uses: 1, used_count: 0, expires_at: '2026-12-03T12:00:00+00:00' },   // UTC 正午：洛杉矶、UTC、首尔三个时区都还是 12 月 3 日（CI 三时区各跑一遍）
];
const ok = <T,>(value: T) => Promise.resolve({ ok: true, value });
const fail = (err: string) => Promise.resolve({ ok: false, err });
const text = (el: Element) => el.textContent ?? '';

beforeEach(() => {
  uiStore.setState({ locale: 'zh-CN' });
  logs.length = 0;
  api.listInvites.mockReturnValue(ok(ROWS));
  api.createInvite.mockReturnValue(ok({ code: CODE, expires_at: '2026-12-04T06:30:00.000Z' }));
  api.revokeInvite.mockReturnValue(ok(true));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const note = () => screen.getByTestId('invite-note') as HTMLInputElement;
const typeNote = (v: string) => fireEvent.change(note(), { target: { value: v } });

describe('设置 › 邀请朋友', () => {
  it('备注框写清“只写编号或日期，不要写名字”、最多 40 个字，挂在输入框的 aria-describedby 上', async () => {
    render(<InviteSettings />);
    const tip = screen.getByTestId('invite-note-tip');
    expect(text(tip)).toContain('只写编号或日期');
    expect(text(tip)).toContain('不要写名字');
    expect(text(tip)).toContain('40');
    const id = note().getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(id)?.textContent).toBe(zh['inv.note.tip'].replace('{max}', '40'));
    await screen.findAllByTestId('invite-row');
  });

  it('列表：备注（没写的写“没写备注”）、用了没有、几号过期', async () => {
    render(<InviteSettings />);
    const rows = await screen.findAllByTestId('invite-row');
    expect(rows).toHaveLength(2);
    expect(text(rows[0] as HTMLElement)).toContain('3 号');
    expect(text(within(rows[0] as HTMLElement).getByTestId('invite-row-used'))).toBe('已用');
    expect(text(rows[1] as HTMLElement)).toContain('没写备注');
    expect(text(within(rows[1] as HTMLElement).getByTestId('invite-row-used'))).toBe('还没用');
    expect(text(within(rows[1] as HTMLElement).getByTestId('invite-row-expires'))).toMatch(/12月3日.*过期$/);
  });

  it('列表空的写“还没有”；读不出来写一句', async () => {
    api.listInvites.mockReturnValue(ok([]));
    render(<InviteSettings />);
    expect(text(await screen.findByTestId('invite-list-empty'))).toContain('还没有');
    cleanup();
    api.listInvites.mockReturnValue(fail('offline'));
    render(<InviteSettings />);
    await screen.findByTestId('invite-list-failed');
  });

  it('生成：带备注调 create → 码大字 4 位一组、写明 7 天有效、只能用一次、只显示这一次；备注清空、列表重读；日志里没有码和备注', async () => {
    render(<InviteSettings />);
    await screen.findAllByTestId('invite-row');
    typeNote(NOTE);
    fireEvent.click(screen.getByTestId('invite-create'));
    expect(api.createInvite).toHaveBeenCalledWith(NOTE);
    expect(text(await screen.findByTestId('invite-code'))).toBe('K7Q2-M9XD-4TPA');
    const tip = text(screen.getByTestId('invite-fresh-tip'));
    expect(tip).toContain('7 天内有效');
    expect(tip).toContain('只能用一次');
    expect(tip).toContain('只显示这一次');
    expect(note().value).toBe('');
    await waitFor(() => expect(api.listInvites).toHaveBeenCalledTimes(2));
    const all = logs.join('\n');
    expect(all).toMatch(/invite create ok/);
    expect(all).toMatch(/invite list ok n=2/);
    expect(all).not.toContain(CODE);
    expect(all).not.toContain('K7Q2');
    expect(all).not.toContain(NOTE);
  });

  it('防连点：请求没回来之前再点、再按回车都不再发', async () => {
    let done: (v: unknown) => void = () => undefined;
    api.createInvite.mockReturnValue(new Promise((r) => (done = r)));
    render(<InviteSettings />);
    const btn = screen.getByTestId('invite-create');
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.keyDown(note(), { key: 'Enter' });
    expect(api.createInvite).toHaveBeenCalledTimes(1);
    expect(text(btn)).toBe('正在生成…');
    await act(async () => {
      done({ ok: true, value: { code: CODE, expires_at: '2026-12-04T06:30:00.000Z' } });
    });
    await screen.findByTestId('invite-code');
  });

  it('复制：clipboard 能用写“已复制”，复制的是 4 位一组的码；日志只记 copy ok', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<InviteSettings />);
    fireEvent.click(screen.getByTestId('invite-create'));
    fireEvent.click(await screen.findByTestId('invite-copy'));
    await waitFor(() => expect(text(screen.getByTestId('invite-copy-status'))).toBe('已复制'));
    expect(writeText).toHaveBeenCalledWith('K7Q2-M9XD-4TPA');
    expect(logs).toContain('invite copy ok');
  });

  it('复制不了（没授权、没有 clipboard）就把码选中，写“请手动复制”', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    render(<InviteSettings />);
    fireEvent.click(screen.getByTestId('invite-create'));
    fireEvent.click(await screen.findByTestId('invite-copy'));
    await waitFor(() => expect(text(screen.getByTestId('invite-copy-status'))).toContain('请手动复制'));
    expect(window.getSelection()?.toString()).toBe('K7Q2-M9XD-4TPA');
    cleanup();
    window.getSelection()?.removeAllRanges();
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    render(<InviteSettings />);
    fireEvent.click(screen.getByTestId('invite-create'));
    fireEvent.click(await screen.findByTestId('invite-copy'));
    await waitFor(() => expect(text(screen.getByTestId('invite-copy-status'))).toContain('请手动复制'));
    expect(window.getSelection()?.toString()).toBe('K7Q2-M9XD-4TPA');
  });

  it('备注超过 40 个字：字数变红、点生成当场提示、不发；改短了提示消失', async () => {
    render(<InviteSettings />);
    typeNote('字'.repeat(41));
    expect(text(screen.getByTestId('invite-note-count'))).toBe('41 / 40');
    fireEvent.click(screen.getByTestId('invite-create'));
    expect(api.createInvite).not.toHaveBeenCalled();
    expect(text(screen.getByTestId('invite-err'))).toBe('备注最多 40 个字');
    expect(note().getAttribute('aria-invalid')).toBe('true');
    typeNote('3 号');
    expect(text(screen.getByTestId('invite-err'))).toBe('');
    await screen.findAllByTestId('invite-row');
  });

  it.each([
    ['rate_limited', '今天已经发了 20 个，明天再试'],
    ['try_later', '服务器暂时不通，稍后再试'],
    ['note_too_long', '备注最多 40 个字'],
    ['bad_request', '备注里有不能用的字符，换一种写法再试'],
    ['not_admin', '只有管理员能发邀请码'],
    ['bad_response', '没有生成，稍后再试'],
  ])('出错 %s：写“%s”，不出码', async (err, line) => {
    api.createInvite.mockReturnValue(fail(err));
    render(<InviteSettings />);
    fireEvent.click(screen.getByTestId('invite-create'));
    await waitFor(() => expect(text(screen.getByTestId('invite-err'))).toBe(line));
    expect(screen.queryByTestId('invite-code')).toBeNull();
    expect(logs.join('\n')).toContain(`invite create err=${err}`);
  });

  it('作废：还没用的行才能左滑出“作废”（同待办左滑删除），已用的不能滑', async () => {
    render(<InviteSettings />);
    const rows = await screen.findAllByTestId('invite-row');
    expect(within(rows[0] as HTMLElement).queryByTestId('invite-revoke')).toBeNull();
    expect((rows[0] as HTMLElement).querySelector('[data-swipe-face]')).toBeNull();
    const btn = within(rows[1] as HTMLElement).getByTestId('invite-revoke');
    expect(text(btn)).toBe('作废');
    expect((rows[1] as HTMLElement).querySelector('[data-swipe-face]')).not.toBeNull();
  });

  it('作废：点了先弹页面里的确认框（不用 confirm()），取消就不发', async () => {
    const native = vi.fn(() => true);
    vi.stubGlobal('confirm', native);
    render(<InviteSettings />);
    fireEvent.click(await screen.findByTestId('invite-revoke'));
    const dlg = await screen.findByRole('dialog');
    expect(text(dlg)).toContain('作废“没写备注”这个邀请码？');
    expect(text(dlg)).toContain('马上不能再用来注册');
    fireEvent.click(screen.getByTestId('invite-revoke-confirm-cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.revokeInvite).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('invite-row')).toHaveLength(2);
  });

  it('作废：确认了才发 revoke（带这一行的 id）→ 这一行马上从列表拿掉、写“已作废”、列表重读；日志只有动作名和结果', async () => {
    let done: (v: unknown) => void = () => undefined;
    api.revokeInvite.mockReturnValue(new Promise((r) => (done = r)));
    render(<InviteSettings />);
    fireEvent.click(await screen.findByTestId('invite-revoke'));
    fireEvent.click(await screen.findByTestId('invite-revoke-confirm-ok'));
    expect(api.revokeInvite).toHaveBeenCalledWith('bbbb0002');
    // 请求没回来：别的行也不给滑出“作废”，不会再发
    expect(screen.queryByTestId('invite-revoke')).toBeNull();
    expect(api.revokeInvite).toHaveBeenCalledTimes(1);
    api.listInvites.mockReturnValue(ok([ROWS[0]]));
    await act(async () => {
      done({ ok: true, value: true });
    });
    await waitFor(() => expect(screen.getAllByTestId('invite-row')).toHaveLength(1));
    expect(text(screen.getByTestId('invite-revoke-status'))).toBe('已作废，这个码不能再用来注册了');
    expect(document.activeElement).toBe(screen.getByTestId('invite-revoke-status'));
    await waitFor(() => expect(api.listInvites).toHaveBeenCalledTimes(2));
    const all = logs.join('\n');
    expect(all).toMatch(/invite revoke ok ms=/);
    expect(all).not.toContain('bbbb0002');
  });

  it.each([
    ['not_found', '这个码已经用掉、过期或作废了，列表已经刷新'],
    ['try_later', '服务器暂时不通，稍后再试'],
    ['offline', '没有网络，连上以后再试'],
    ['bad_response', '没有作废成，稍后再试'],
  ])('作废没成 %s：写“%s”，列表重读', async (err, line) => {
    api.revokeInvite.mockReturnValue(fail(err));
    render(<InviteSettings />);
    fireEvent.click(await screen.findByTestId('invite-revoke'));
    fireEvent.click(await screen.findByTestId('invite-revoke-confirm-ok'));
    await waitFor(() => expect(text(screen.getByTestId('invite-revoke-status'))).toBe(line));
    await waitFor(() => expect(api.listInvites).toHaveBeenCalledTimes(2));
    expect(logs.join('\n')).toContain(`invite revoke err=${err}`);
  });

  it('作废的正是刚生成、还显示在上面的那个码：上面那张卡收掉', async () => {
    const fresh = { id: 'cccc0003', note: NOTE, max_uses: 1, used_count: 0, expires_at: '2026-12-04T06:30:00+00:00' };
    render(<InviteSettings />);
    await screen.findAllByTestId('invite-row');
    api.listInvites.mockReturnValue(ok([fresh, ...ROWS]));
    fireEvent.click(screen.getByTestId('invite-create'));
    await screen.findByTestId('invite-code');
    await waitFor(() => expect(screen.getAllByTestId('invite-row')).toHaveLength(3));
    // 先作废别的那个：上面的卡还在
    fireEvent.click(within(screen.getAllByTestId('invite-row')[2] as HTMLElement).getByTestId('invite-revoke'));
    fireEvent.click(await screen.findByTestId('invite-revoke-confirm-ok'));
    await waitFor(() => expect(text(screen.getByTestId('invite-revoke-status'))).toContain('已作废'));
    expect(screen.queryByTestId('invite-code')).not.toBeNull();
    fireEvent.click(within(screen.getAllByTestId('invite-row')[0] as HTMLElement).getByTestId('invite-revoke'));
    fireEvent.click(await screen.findByTestId('invite-revoke-confirm-ok'));
    await waitFor(() => expect(screen.queryByTestId('invite-code')).toBeNull());
  });

  it('韩文：按钮、说明换成韩文', async () => {
    uiStore.setState({ locale: 'ko-KR' });
    render(<InviteSettings />);
    expect(text(screen.getByTestId('invite-create'))).toBe('초대 코드 만들기');
    expect(text(screen.getByTestId('invite-note-tip'))).toContain('이름은 적지 마세요');
    await screen.findAllByTestId('invite-row');
  });
});
