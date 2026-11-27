// 设置 › 我的 AI、AI 服务商（R-494）：首页两行、我的 AI 的几种状态、切换前提示的条目（负责人 11-22 按 ownCovers 改）、删除二次确认、管理员页选一家
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminGetRes, MineRes } from '../../../../shared/schema/ai-provider.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import type * as Api from '../data/provider-api.ts';

const api = {
  readMine: vi.fn(), adminGet: vi.fn(), ownTest: vi.fn(), ownUse: vi.fn(), ownOff: vi.fn(), ownDelete: vi.fn(),
  adminTest: vi.fn(), adminKey: vi.fn(), adminRoute: vi.fn(), adminWeb: vi.fn(),
};
const usage = vi.fn();
vi.mock('../data/provider-api.ts', async (orig) => ({
  ...(await orig<typeof Api>()),
  readMine: () => api.readMine(),
  adminGet: () => api.adminGet(),
  ownTest: (r: unknown) => api.ownTest(r),
  ownUse: (r: unknown) => api.ownUse(r),
  ownOff: () => api.ownOff(),
  ownDelete: () => api.ownDelete(),
  adminTest: (r: unknown) => api.adminTest(r),
  adminKey: (r: unknown) => api.adminKey(r),
  adminRoute: (t: unknown, p: unknown) => api.adminRoute(t, p),
  adminWeb: (ps: unknown) => api.adminWeb(ps),
}));
vi.mock('../../../platform/ai-usage.ts', () => ({ readAiUsage: () => usage() }));
const { default: Parts } = await import('../ui/AiProviderSettings.tsx');
const { adminBox, mineBox } = await import('../data/store.ts');

const none = { model: null, last4: null, saved_at: null, has_key: false };
const ADMIN: AdminGetRes = {
  routes: { chat: null, stt: null, embed: null },
  web: ['brave'],
  keys: {
    gemini: { model: 'gemini-3-flash', last4: 'x7Qc', saved_at: 1, has_key: true }, claude: { model: 'claude-haiku-5-5', last4: 'K2vQ', saved_at: 1, has_key: true }, openai: none, deepseek: none,
    brave: { model: null, last4: 'Bv9k', saved_at: 1, has_key: true }, tavily: none, naver: none,
  },
};
const lemo = (admin = false): MineRes => ({ admin, project: 'gemini', own: null, images: true });
const ownOn: MineRes = { admin: false, project: 'gemini', own: { provider: 'openai', model: 'gpt-5-mini', last4: 'a1B2', active: true, fell_back: null }, images: false };
const ok = <T,>(value: T) => Promise.resolve({ ok: true, value });
// 仓库没装 jest-dom：用普通 DOM 属性断言
const checked = (el: Element) => (el as HTMLInputElement).checked;
const off = (el: Element) => (el as HTMLButtonElement).disabled;
const text = (el: Element) => el.textContent ?? '';
const val = (el: Element) => (el as HTMLInputElement).value;

beforeEach(() => {
  uiStore.setState({ locale: 'zh-CN' });
  mineBox.set({ kind: 'loading' });
  adminBox.set({ kind: 'loading' });
  api.readMine.mockReturnValue(ok(lemo()));
  api.adminGet.mockReturnValue(ok(ADMIN));
  usage.mockResolvedValue({ ok: true, value: { used: 12, limit: 50, unlimited: false } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('设置首页两行', () => {
  it('我的 AI 的值：柠檬记提供 · 12 / 50；用自己的密钥时“自己的密钥 · OpenAI”', async () => {
    const { container, unmount } = render(<Parts part="myAiValue" />);
    await waitFor(() => expect(container.textContent).toBe('柠檬记提供 · 12 / 50'));
    unmount();
    mineBox.set({ kind: 'loading' });
    api.readMine.mockReturnValue(ok(ownOn));
    const again = render(<Parts part="myAiValue" />);
    await waitFor(() => expect(again.container.textContent).toBe('自己的密钥 · OpenAI'));
  });

  it('AI 服务商一行：不是管理员不画；管理员画、值是对话和整理那家', async () => {
    const open = vi.fn();
    const { container, unmount } = render(<Parts part="adminRow" label="AI 服务商" onOpen={open} />);
    await waitFor(() => expect(api.readMine).toHaveBeenCalled());
    await act(async () => undefined);
    expect(container.textContent).toBe('');
    unmount();
    mineBox.set({ kind: 'loading' });
    api.readMine.mockReturnValue(ok({ ...lemo(true), project: 'claude' }));
    render(<Parts part="adminRow" label="AI 服务商" onOpen={open} />);
    fireEvent.click(await screen.findByTestId('settings-ai-provider-entry'));
    expect(open).toHaveBeenCalled();
    expect(screen.getByTestId('settings-ai-provider-summary').textContent).toBe('Claude');
  });
});

describe('我的 AI', () => {
  it('默认：柠檬记的打勾、今天用量和清零时刻、底下“柠檬记现在用的是 Gemini（谷歌）。”', async () => {
    render(<Parts part="myAi" />);
    expect(checked(await screen.findByTestId('aip-my-lemo'))).toBe(true);
    await waitFor(() => expect(screen.getByTestId('aip-my-pick').textContent).toMatch(/今天用了 12 \/ 50 次，[上下]午 \d{1,2} 点( \d{1,2} 分)?清零/));
    expect(screen.getByTestId('aip-my-pick').textContent).not.toMatch(/\d\d:\d\d/);
    expect(screen.getByTestId('aip-my-project').textContent).toBe('柠檬记现在用的是 Gemini（谷歌）。');
    expect(screen.getByTestId('aip-mem').textContent).toContain('换不换 AI 都在');
  });

  it('选自己的 → 选 OpenAI、填模型名和密钥 → 试一下通了才能点“改用这把密钥” → 切换前提示（只接管对话）→ 确定改用调 own_use', async () => {
    api.ownTest.mockReturnValue(ok({ ok: true, ms: 900 }));
    api.ownUse.mockReturnValue(ok({ done: true }));
    render(<Parts part="myAi" />);
    fireEvent.click(await screen.findByTestId('aip-my-own'));
    fireEvent.click(screen.getByTestId('aip-own-openai'));
    expect(off(screen.getByTestId('aip-use'))).toBe(true);
    expect(off(screen.getByTestId('aip-test'))).toBe(true);
    fireEvent.change(screen.getByTestId('aip-model'), { target: { value: 'gpt-5-mini' } });
    const key = screen.getByTestId('aip-key');
    expect((key).getAttribute('type')).toBe('password');
    expect((key).getAttribute('autocomplete')).toBe('off');
    expect((key).getAttribute('spellcheck')).toBe('false');
    fireEvent.change(key, { target: { value: 'fake-aaaaaaaa-a1B2' } });
    fireEvent.click(screen.getByTestId('aip-test'));
    expect(text(await screen.findByTestId('aip-test-ok'))).toContain('试过了，通了OpenAI 回话用了 0.9 秒。');
    expect(api.ownTest).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5-mini', key: 'fake-aaaaaaaa-a1B2' });
    fireEvent.click(screen.getByTestId('aip-use'));
    const ask = await screen.findByTestId('aip-ask');
    expect(screen.getByRole('dialog', { name: '以后你的文字会发给 OpenAI' })).toBeTruthy();
    expect(within(ask).getByTestId('aip-ask-covers').textContent).toBe('对话、整理随手记时，你的文字会发到 OpenAI，按它的规定处理；');
    expect(within(ask).getByTestId('aip-ask-rest').textContent).toBe('联网、录音转文字、搜索仍由柠檬记的 AI 做，照旧占每天 50 次；');
    fireEvent.click(screen.getByTestId('aip-ask-ok'));
    await waitFor(() => expect(api.ownUse).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5-mini', key: 'fake-aaaaaaaa-a1B2' }));
  });

  it('改了输入，试的结果作废、“改用”又变灰；Gemini 接管对话和录音转文字', async () => {
    api.ownTest.mockReturnValue(ok({ ok: true, ms: 500 }));
    render(<Parts part="myAi" />);
    fireEvent.click(await screen.findByTestId('aip-my-own'));
    fireEvent.click(screen.getByTestId('aip-own-gemini'));
    fireEvent.change(screen.getByTestId('aip-model'), { target: { value: 'gemini-3-flash' } });
    fireEvent.change(screen.getByTestId('aip-key'), { target: { value: 'AIza-abcdefgh' } });
    fireEvent.click(screen.getByTestId('aip-test'));
    await screen.findByTestId('aip-test-ok');
    expect(off(screen.getByTestId('aip-use'))).toBe(false);
    fireEvent.click(screen.getByTestId('aip-use'));
    expect((await screen.findByTestId('aip-ask-covers')).textContent).toBe('对话、整理随手记、录音转文字时，你的文字会发到 Gemini，按它的规定处理；');
    expect(screen.getByTestId('aip-ask-rest').textContent).toBe('联网、搜索仍由柠檬记的 AI 做，照旧占每天 50 次；');
    fireEvent.click(screen.getByTestId('aip-ask-back'));
    fireEvent.change(screen.getByTestId('aip-key'), { target: { value: 'AIza-abcdefgh2' } });
    expect(screen.queryByTestId('aip-test-ok')).toBeNull();
    expect(off(screen.getByTestId('aip-use'))).toBe(true);
  });

  it('没通：标题写原因、正文、其他几种原因', async () => {
    api.ownTest.mockReturnValue(ok({ ok: false, code: 'auth', status: 401 }));
    render(<Parts part="myAi" />);
    fireEvent.click(await screen.findByTestId('aip-my-own'));
    fireEvent.click(screen.getByTestId('aip-own-claude'));
    fireEvent.change(screen.getByTestId('aip-model'), { target: { value: 'claude-haiku-5-5' } });
    fireEvent.change(screen.getByTestId('aip-key'), { target: { value: 'sk-ant-abcdefgh' } });
    fireEvent.click(screen.getByTestId('aip-test'));
    const fail = await screen.findByTestId('aip-test-fail');
    expect(fail.textContent).toBe('没通：密钥不对Claude 回的是 401（认不出这把密钥）。重贴一次，注意别多复制空格。其他可能的原因也会这样直说：模型名不存在 · 余额或额度用完 · 连不上（10 秒没回）。');
    expect(off(screen.getByTestId('aip-use'))).toBe(true);
  });

  it('已用自己的：我的密钥一行、谁做什么；删除要点两次，删完回到柠檬记的', async () => {
    api.readMine.mockReturnValue(ok(ownOn));
    api.ownDelete.mockReturnValue(ok({ done: true }));
    render(<Parts part="myAi" />);
    expect(text(await screen.findByTestId('aip-mine-meta'))).toContain('密钥 ····a1B2');
    expect(screen.queryByTestId('aip-fell-back')).toBeNull();
    expect(screen.getByTestId('aip-who').textContent).toBe('谁做什么对话和整理：你的 OpenAI，不占次数联网搜索、录音转文字、向量搜索：柠檬记的 Gemini，占次数（今天 12 / 50）');
    // 再问一次是 kit 的通用确认框（负责人 11-25“14、15 都改成一样”）：标题、正文、“不删”“删除”照原词典
    fireEvent.click(screen.getByTestId('aip-del'));
    expect(api.ownDelete).not.toHaveBeenCalled();
    const ask = await screen.findByRole('dialog');
    expect(text(ask)).toContain('删掉这把密钥？');
    expect(text(ask)).toContain('删了就回到柠檬记提供的 AI（占每天 50 次）；密钥找不回来，要用得重贴。');
    expect(text(screen.getByTestId('aip-del-ask-cancel'))).toBe('不删');
    expect(text(screen.getByTestId('aip-del-ask-ok'))).toBe('删除');
    fireEvent.click(screen.getByTestId('aip-del-ask-cancel'));
    await waitFor(() => expect(screen.queryByTestId('aip-del-ask-ok')).toBeNull());
    expect(api.ownDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('aip-del'));
    api.readMine.mockReturnValue(ok(lemo()));
    fireEvent.click(await screen.findByTestId('aip-del-ask-ok'));
    await waitFor(() => expect(checked(screen.getByTestId('aip-my-lemo'))).toBe(true));
    expect(api.ownDelete).toHaveBeenCalledTimes(1);
  });

  it('密钥用不了、自动改用过柠檬记的 AI：我的密钥下面写一句（负责人 11-23）', async () => {
    api.readMine.mockReturnValue(ok({ ...ownOn, own: { provider: 'openai', model: 'gpt-5-mini', last4: 'a1B2', active: true, fell_back: { at: 1, why: 'quota' } } }));
    render(<Parts part="myAi" />);
    expect(text(await screen.findByTestId('aip-fell-back'))).toBe('你的密钥用不了（欠费或额度满了），这次用了柠檬记的 AI，占每天 50 次。');
  });

  it('已用自己的再点“用柠檬记提供的 AI”调 own_off', async () => {
    api.readMine.mockReturnValue(ok(ownOn));
    api.ownOff.mockReturnValue(ok({ done: true }));
    render(<Parts part="myAi" />);
    await screen.findByTestId('aip-mine-meta');
    api.readMine.mockReturnValue(ok({ ...ownOn, own: { provider: 'openai', model: 'gpt-5-mini', last4: 'a1B2', active: false, fell_back: null } }));
    fireEvent.click(screen.getByTestId('aip-my-lemo'));
    await waitFor(() => expect(api.ownOff).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(checked(screen.getByTestId('aip-my-lemo'))).toBe(true));
  });
});

describe('AI 服务商（管理员）', () => {
  it('四项用途、四家密钥；点“录音转文字”弹层：做不了的变灰、写原因；点能选的一家调 admin_route', async () => {
    api.adminRoute.mockReturnValue(ok({ done: true }));
    render(<Parts part="admin" onOpenKey={vi.fn()} />);
    expect(text(await screen.findByTestId('aip-route-chat-value'))).toContain('Gemini');
    expect(text(screen.getByTestId('aip-key-claude-value'))).toContain('····K2vQ');
    expect(text(screen.getByTestId('aip-key-openai-value'))).toContain('没填');
    fireEvent.click(screen.getByTestId('aip-route-stt'));
    const sheet = await screen.findByRole('dialog', { name: '录音转文字用哪家' });
    expect(checked(within(sheet).getByTestId('aip-pick-gemini'))).toBe(true);
    expect(off(within(sheet).getByTestId('aip-pick-claude'))).toBe(true);
    expect(off(within(sheet).getByTestId('aip-pick-openai'))).toBe(true);
    expect(sheet.textContent).toContain('Claude没有这项');
    expect(sheet.textContent).toContain('OpenAI还没接上');
    fireEvent.click(screen.getByTestId('aip-pick-claude'));
    expect(api.adminRoute).not.toHaveBeenCalled();
  });

  it('对话和整理选 Claude（已填密钥 · 试通过）→ admin_route chat claude，弹层关上', async () => {
    api.adminRoute.mockReturnValue(ok({ done: true }));
    render(<Parts part="admin" onOpenKey={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('aip-route-chat'));
    const sheet = await screen.findByRole('dialog', { name: '对话和整理用哪家' });
    expect(sheet.textContent).toContain('Claude已填密钥 · 试通过');
    expect(sheet.textContent).toContain('OpenAI还没填密钥');
    api.adminGet.mockReturnValue(ok({ ...ADMIN, routes: { ...ADMIN.routes, chat: 'claude' } }));
    fireEvent.click(within(sheet).getByTestId('aip-pick-claude'));
    await waitFor(() => expect(api.adminRoute).toHaveBeenCalledWith('chat', 'claude'));
    await waitFor(() => expect(text(screen.getByTestId('aip-route-chat-value'))).toContain('Claude'));
  });

  it('密钥详情：已存的显示后四位、“重贴”出空密码框；只改模型名也能试；试通了才能保存，保存调 admin_key', async () => {
    api.adminTest.mockReturnValue(ok({ ok: true, ms: 800 }));
    api.adminKey.mockReturnValue(ok({ done: true }));
    render(<Parts part="adminKey" provider="claude" />);
    expect(text(await screen.findByTestId('aip-key-masked'))).toContain('K2vQ');
    expect(val(screen.getByTestId('aip-model'))).toBe('claude-haiku-5-5');
    expect(text(screen.getByTestId('aip-lacks'))).toContain('Claude 没有：录音转文字、向量搜索');
    expect(off(screen.getByTestId('aip-save'))).toBe(true);
    fireEvent.click(screen.getByTestId('aip-test'));
    expect(text(await screen.findByTestId('aip-test-ok'))).toContain('Claude 回话用了 0.8 秒。这次试不算次数。');
    expect(api.adminTest).toHaveBeenCalledWith({ provider: 'claude', model: 'claude-haiku-5-5', key: '' });
    fireEvent.click(screen.getByTestId('aip-save'));
    await waitFor(() => expect(api.adminKey).toHaveBeenCalledWith({ provider: 'claude', model: 'claude-haiku-5-5', key: '' }));
    expect(text(await screen.findByTestId('aip-saved'))).toContain('存好了。');
    fireEvent.click(screen.getByTestId('aip-repaste'));
    expect(val(screen.getByTestId('aip-key'))).toBe('');
  });

  it('联网搜索（11-25 各自打勾）：用途行写勾的几家；弹层“联网搜索方式”列四家、每家一个勾（复选框，没有三家联合），没密钥的灰，带退备用的说明；“密钥”卡多 Brave、Tavily、Naver 三行', async () => {
    render(<Parts part="admin" onOpenKey={vi.fn()} />);
    expect(text(await screen.findByTestId('aip-route-web-value'))).toBe('Brave');
    expect(text(screen.getByTestId('aip-key-brave-value'))).toContain('····Bv9k');
    expect(text(screen.getByTestId('aip-key-tavily-value'))).toContain('没填');
    expect(text(screen.getByTestId('aip-key-naver-value'))).toContain('没填');
    fireEvent.click(screen.getByTestId('aip-route-web'));
    const sheet = await screen.findByRole('dialog', { name: '联网搜索方式' });
    expect(within(sheet).getByRole('group', { name: '联网搜索方式' })).toBeTruthy();
    expect(within(sheet).getAllByRole('checkbox')).toHaveLength(4);
    expect(checked(within(sheet).getByTestId('aip-pick-brave'))).toBe(true);
    expect(off(within(sheet).getByTestId('aip-pick-tavily'))).toBe(true);
    expect(off(within(sheet).getByTestId('aip-pick-naver'))).toBe(true);
    expect(off(within(sheet).getByTestId('aip-pick-deepseek'))).toBe(true);
    expect(within(sheet).queryByTestId('aip-pick-multi')).toBe(null);
    expect(sheet.textContent).not.toContain('三家联合');
    expect(sheet.textContent).toContain('勾了几家就同时搜几家');
    expect(sheet.textContent).toContain('至少勾一家');
    expect(within(sheet).queryByTestId('aip-pick-gemini')).toBe(null);
  });

  it('勾上一家 → admin_web_route 发勾的几家，弹层不关、行值写“Brave + Tavily”；再取消回到一家', async () => {
    api.adminWeb.mockReturnValue(ok({ done: true }));
    api.adminGet.mockReturnValue(ok({ ...ADMIN, keys: { ...ADMIN.keys, tavily: { model: null, last4: 'Tv1y', saved_at: 1, has_key: true } } }));
    render(<Parts part="admin" onOpenKey={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('aip-route-web'));
    const sheet = await screen.findByRole('dialog', { name: '联网搜索方式' });
    const withT = { ...ADMIN, web: ['brave', 'tavily'], keys: { ...ADMIN.keys, tavily: { model: null, last4: 'Tv1y', saved_at: 1, has_key: true } } } satisfies AdminGetRes;
    api.adminGet.mockReturnValue(ok(withT));
    fireEvent.click(within(sheet).getByTestId('aip-pick-tavily'));
    await waitFor(() => expect(api.adminWeb).toHaveBeenCalledWith(['brave', 'tavily']));
    await waitFor(() => expect(text(screen.getByTestId('aip-route-web-value'))).toBe('Brave + Tavily'));
    expect(screen.getByRole('dialog', { name: '联网搜索方式' })).toBeTruthy();
    await waitFor(() => expect(checked(within(sheet).getByTestId('aip-pick-tavily'))).toBe(true));
    api.adminGet.mockReturnValue(ok({ ...withT, web: ['tavily'] }));
    fireEvent.click(within(sheet).getByTestId('aip-pick-brave'));
    await waitFor(() => expect(api.adminWeb).toHaveBeenLastCalledWith(['tavily']));
    await waitFor(() => expect(text(screen.getByTestId('aip-route-web-value'))).toBe('Tavily'));
    expect(api.adminRoute).not.toHaveBeenCalled();
  });

  it('只剩一个勾时取消没反应（至少勾一家）；没密钥的勾不上；已经勾着、后来密钥被删的能取消', async () => {
    api.adminWeb.mockReturnValue(ok({ done: true }));
    api.adminGet.mockReturnValue(ok({ ...ADMIN, web: ['deepseek', 'brave'] }));
    render(<Parts part="admin" onOpenKey={vi.fn()} />);
    expect(text(await screen.findByTestId('aip-route-web-value'))).toBe('DeepSeek + Brave');
    fireEvent.click(screen.getByTestId('aip-route-web'));
    const sheet = await screen.findByRole('dialog', { name: '联网搜索方式' });
    // DeepSeek 没密钥但勾着：不灰、能取消；Naver 没密钥没勾：灰、点了不发
    expect(off(within(sheet).getByTestId('aip-pick-deepseek'))).toBe(false);
    fireEvent.click(within(sheet).getByTestId('aip-pick-naver'));
    expect(api.adminWeb).not.toHaveBeenCalled();
    api.adminGet.mockReturnValue(ok(ADMIN));
    fireEvent.click(within(sheet).getByTestId('aip-pick-deepseek'));
    await waitFor(() => expect(api.adminWeb).toHaveBeenCalledWith(['brave']));
    await waitFor(() => expect(text(screen.getByTestId('aip-route-web-value'))).toBe('Brave'));
    await waitFor(() => expect(off(within(sheet).getByTestId('aip-pick-brave'))).toBe(false));
    fireEvent.click(within(sheet).getByTestId('aip-pick-brave'));
    await act(async () => undefined);
    expect(api.adminWeb).toHaveBeenCalledTimes(1);
    expect(checked(within(sheet).getByTestId('aip-pick-brave'))).toBe(true);
  });

  it('Brave 的密钥页：只有密钥一格（没有模型名）、没有“这家没有”卡；不贴新的也能用库里那把试', async () => {
    api.adminTest.mockReturnValue(ok({ ok: true, ms: 300 }));
    render(<Parts part="adminKey" provider="brave" />);
    expect(text(await screen.findByTestId('aip-key-masked'))).toContain('Bv9k');
    expect(screen.queryByTestId('aip-model')).toBe(null);
    expect(screen.queryByTestId('aip-lacks')).toBe(null);
    fireEvent.click(screen.getByTestId('aip-test'));
    await waitFor(() => expect(api.adminTest).toHaveBeenCalledWith({ provider: 'brave', model: '', key: '' }));
  });

  it('认不出的服务商（地址乱写）什么都不画', () => {
    const { container } = render(<Parts part="adminKey" provider="nope" />);
    expect(container.textContent).toBe('');
  });
});
