// 中韩切换和“改语言后刷新”（TC-B1-19；架构 2.4 第 4 条、16.4）
// • 点“한국어”：设置页全部文字立刻换成韩文词典、<html lang> 换成 ko-KR、本机记下 pv-locale 和 lemo_lang、账号写 ko-KR
// • 刷新：新的一页 ui-store 从中文起步，入口按“pv-locale → 设备语言 → 中文”（pickLocale，和 src/auth/main.tsx 同一条规则）定语言，
//   结果仍是韩文；设备语言是中文也一样（手动选过的优先）
// 韩文词典换成“[ko]+中文”：真韩文还没翻（TODO(ko)），这样才分得出文字是不是真的跟着换了
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeholdersOf } from '../../../../shared/i18n/i18n.ts';
import { pickLocale, toUiLocale } from '../../../../shared/i18n/pick-locale.ts';
import { uiStore } from '../../../kit/state/ui-store.ts';
import { readLocalLocale } from '../data/local.ts';
import type { SettingsApi } from '../data/settings-api.ts';
import { applyLocale } from '../hooks/useLocaleSwitch.ts';
import type { ExitDeps } from '../hooks/useSessionExit.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';
import SettingsPage from '../ui/SettingsPage.tsx';

vi.mock('../i18n/ko.ts', async () => {
  const { zh: z } = await vi.importActual<{ zh: Record<string, string> }>('../i18n/zh.ts');
  // 语言名两边一样（“中文”“한국어”），其余加 [ko] 前缀
  return { ko: Object.fromEntries(Object.entries(z).map(([k, v]) => [k, k === 'settings.lang.zh' || k === 'settings.lang.ko' ? v : `[ko]${v}`])) };
});

const ok = { ok: true as const, value: undefined };

function fakeApi(over: Partial<SettingsApi> = {}) {
  return {
    loadDevices: vi.fn(async () => ({ ok: true as const, value: { rows: [], sessions: null, session: null } })),
    removeDevice: vi.fn(async () => ok),
    signOutOthers: vi.fn(async () => ok),
    deleteOwnDevice: vi.fn(async () => undefined),
    dropLocalSession: vi.fn(async () => ({ serverDone: true })),
    saveLocale: vi.fn(async () => ok),
    ...over,
  };
}

const exit: ExitDeps = {
  wipe: vi.fn(async () => true),
  deleteDb: vi.fn(async () => undefined),
  clearCacheStorage: vi.fn(async () => undefined),
  clearLocalSession: vi.fn(),
  readSessionId: () => null,
  readUserId: () => null,
  pendingCount: async () => 0,
  goToAuth: vi.fn(),
};

/** 模拟一次页面载入：ui-store 回到默认中文，再按入口的规则定语言（同 src/auth/main.tsx） */
function bootLikeEntry(deviceLangs: readonly string[]): void {
  uiStore.getState().setLocale('zh-CN');
  document.documentElement.lang = '';
  const locale = pickLocale(readLocalLocale(), deviceLangs);
  uiStore.getState().setLocale(toUiLocale(locale));
  document.documentElement.lang = toUiLocale(locale);
}

async function renderPage(api = fakeApi()) {
  render(<SettingsPage deps={{ api, exit }} />);
  // 等设备列表读完（空列表那一句，中文和 [ko] 两种都认）
  await screen.findByText(new RegExp(zh['settings.devices.empty']));
  return api;
}

function title(): string {
  return screen.getByRole('heading', { level: 1 }).textContent ?? '';
}

function pressed(): string | null {
  return document.querySelector('[data-testid="settings-lang"] [aria-pressed="true"]')?.getAttribute('data-locale') ?? null;
}

beforeEach(() => {
  localStorage.clear();
  document.cookie = 'lemo_lang=; Max-Age=0; Path=/';
  bootLikeEntry(['zh-CN']);
});
afterEach(cleanup);

describe('中韩切换', () => {
  it('点“한국어”：整页文字跟着变、<html lang> 变 ko-KR、本机记下、账号写 ko-KR', async () => {
    const api = await renderPage();
    expect(title()).toBe(zh['settings.title']);
    expect(pressed()).toBe('zh');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['settings.lang.ko'] }));
    });
    expect(title()).toBe(`[ko]${zh['settings.title']}`);
    expect(screen.getByRole('button', { name: `[ko]${zh['settings.account.signOut']}` })).toBeTruthy();
    // 页面上不再剩中文词典的原文（除了两个语言名）
    const main = document.querySelector('main[data-feature="settings"]')?.textContent ?? '';
    expect(main).not.toContain(zh['settings.devices.signOutOthers'].replace(/^/, '\u0000'));
    expect(main.split(`[ko]${zh['settings.devices.title']}`)).toHaveLength(2);
    expect(pressed()).toBe('ko');
    expect(document.documentElement.lang).toBe('ko-KR');
    expect(localStorage.getItem('pv-locale')).toBe('ko');
    expect(document.cookie).toContain('lemo_lang=ko');
    expect(api.saveLocale).toHaveBeenCalledWith('ko-KR');
  });

  it('再点当前语言不重复写', async () => {
    const api = await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['settings.lang.zh'] }));
    });
    expect(api.saveLocale).not.toHaveBeenCalled();
  });

  it('账号写不进（断网）：界面照样换成韩文，只提示一句', async () => {
    await renderPage(fakeApi({ saveLocale: vi.fn(async () => ({ ok: false as const, error: 'offline' as const })) }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['settings.lang.ko'] }));
    });
    expect(title()).toBe(`[ko]${zh['settings.title']}`);
    expect((await screen.findByRole('alert')).textContent).toBe(`[ko]${zh['settings.lang.syncFailed']}`);
    expect(exit.wipe).not.toHaveBeenCalled();
  });
});

describe('改语言后刷新（TC-B1-19“刷新后保持”）', () => {
  it('换成韩文后刷新：仍是韩文（设备语言是中文也一样）', async () => {
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['settings.lang.ko'] }));
    });
    cleanup();

    bootLikeEntry(['zh-CN', 'en-US']);
    await renderPage();
    expect(title()).toBe(`[ko]${zh['settings.title']}`);
    expect(pressed()).toBe('ko');
    expect(document.documentElement.lang).toBe('ko-KR');
  });

  it('换回中文后刷新：是中文（设备语言是韩文也一样）', async () => {
    applyLocale('ko');
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh['settings.lang.zh'] }));
    });
    cleanup();

    bootLikeEntry(['ko-KR']);
    await renderPage();
    expect(title()).toBe(zh['settings.title']);
    expect(pressed()).toBe('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('从没选过：按设备语言（ko-KR → 韩文）', async () => {
    bootLikeEntry(['ko-KR']);
    await renderPage();
    await waitFor(() => expect(pressed()).toBe('ko'));
  });
});

describe('settings 词典', () => {
  it('中韩两份键一样、占位符一样', () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(zh).sort());
    for (const k of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(placeholdersOf(ko[k]), k).toEqual(placeholdersOf(zh[k]));
    }
  });

  it('韩文还没翻译的行（没有谚文）都标了 TODO(ko)；语言名“中文”不用翻', () => {
    const src = readFileSync(join(import.meta.dirname, '../i18n/ko.ts'), 'utf8');
    const lines = src.split('\n').filter((l) => /^\s+'settings\./.test(l));
    expect(lines.length).toBe(Object.keys(zh).length);
    for (const line of lines) {
      if (line.includes("'settings.lang.zh'")) continue;
      const value = /:\s*'(.*)',/.exec(line)?.[1] ?? '';
      if (!/[가-힯]/.test(value)) expect(line, line).toContain('TODO(ko)');
    }
  });
});
