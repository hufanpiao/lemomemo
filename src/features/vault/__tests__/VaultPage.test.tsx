// 隐私记页面（ui/VaultPage.tsx）：TC-B5-11（上锁后 DOM 里不留明文）、TC-B5-12（挂着时 <html data-solid="1">，卸掉还原；GlassBar 不碰隐私记）、
// TC-B5-13（解锁卡淡出 --dur-ui，上锁、多任务遮罩直接盖）、TC-B5-44（三个离开事件同步盖遮罩，59 秒回来去掉、61 秒上锁）、
// TC-B5-33（断网进不去）、TC-B5-48 ②（解锁后看得到自己的“最近删除”，永久删除要确认）
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultRequest } from '../../../../shared/schema/vault.ts';
import { createVaultSession, type VaultSession } from '../data/session.ts';
import { FRAME_POLL_MS, installVaultSession, PICK_MS, SHIELD_ATTR, watchLeave } from '../hooks/useVault.ts';
import VaultPage from '../ui/VaultPage.tsx';
import VaultParts from '../ui/VaultParts.tsx';
import { applyLook } from '../../../platform/look.ts';
import { useKeys } from '../../../kit/hooks/layers.ts';
import type * as Enc from '../../../platform/image-encode.ts';
import { fakeApi, make, NID, note, TOK } from './session-fakes.ts';

// 分类集合可由用例填（“＋ 新分类”）；别的集合一律空
const cats = vi.hoisted(() => ({ rows: [] as { id: string; name: string; vault?: boolean }[] }));
vi.mock('../../../kit/hooks/useCollection.ts', () => ({ useCollection: (t: string) => (t === 'categories' ? cats.rows : []) }));
vi.mock('../../notes/data/category-new.ts', async (orig) => ({
  ...(await orig<object>()),
  // 隐私记、随手记各一套（categories.vault）：照真函数只在同一套里查重名、新建带 vault
  createCategory: vi.fn(async (name: string, vault: boolean) => {
    const had = cats.rows.find((c) => c.name === name.trim() && (c.vault === true) === vault);
    if (had) return { result: 'ok', id: had.id, existed: true };
    cats.rows = [...cats.rows, { id: 'new-cat', name: name.trim(), vault }];
    return { result: 'ok', id: 'new-cat', existed: false };
  }),
}));
// 插图：jsdom 没有画布，压图换成桩（压成了一张 10×6 的图）
vi.mock('../../../platform/image-encode.ts', async (orig) => ({
  ...(await orig<typeof Enc>()),
  encodeImage: async () => ({ ok: true, full: new Blob(['full']), thumb: new Blob(['t']), width: 10, height: 6, takenAt: null }),
}));

const GONE = '22222222-2222-4222-8222-222222222222';
const SECRET = note().body;

const LISTED = { ok: true, notes: [note(), note({ id: GONE, title: '旧的', body: '删掉的', deleted_at: 5 })], vault_token: TOK, expires_at: 9e12 };

function session(o: { offline?: boolean; purge?: () => void; exportFail?: boolean; list?: () => unknown; now?: () => number } = {}): VaultSession {
  const reply = (req: VaultRequest): unknown => {
    switch (req.action) {
      case 'status':
        return o.offline ? { ok: false, code: 'offline' } : { ok: true, set: true, locked_until: null, retry_after_s: null, last_reset_at: null, webauthn: 0 };
      case 'list':
        return o.list ? o.list() : LISTED;
      case 'purge':
        o.purge?.();
        return { ok: true, purged: 1, vault_token: TOK, expires_at: 9e12 };
      case 'export':
        return o.exportFail ? { ok: false, code: 'unknown' } : { ok: true, vault_token: TOK, expires_at: 9e12 };
      default:
        return { ok: true, vault_token: TOK, expires_at: 9e12 };
    }
  };
  // 每个动作都走 reply（假 api 是会话测试那一份；时间、睡眠用真的，计时用例靠假计时器）
  const { api } = fakeApi({}, reply);
  return createVaultSession({ api, onToken: () => undefined, createUrl: () => 'blob:x', revokeUrl: () => undefined, ...(o.now ? { now: o.now } : {}) });
}

let s: VaultSession;
beforeEach(() => {
  window.location.hash = '#/vault';
  document.documentElement.removeAttribute('data-rt');
  document.documentElement.removeAttribute('data-solid');
  document.documentElement.removeAttribute(SHIELD_ATTR);
});
afterEach(() => {
  cleanup();
  installVaultSession(null);
  window.location.hash = '';
});

async function openUnlocked(o: Parameters<typeof session>[0] = {}) {
  s = session(o);
  installVaultSession(s);
  render(<VaultPage />);
  await screen.findByTestId('vault-unlock-card');
  await act(async () => {
    await s.unlock('1234');
  });
  await screen.findByTestId('vault-notes');
}

describe('解锁、上锁', () => {
  it('线框 s9：用不了 Face ID 时解锁卡只有“输入密码”“取消”；点了进整页密码页，顶栏“‹ 随手记 … 取消”，提示在圆点下、键盘上；手机宽度不出快捷键提示', async () => {
    s = session();
    installVaultSession(s);
    render(<VaultPage />);
    const card = await screen.findByTestId('vault-unlock-card');
    expect(screen.queryByTestId('vault-unlock-face')).toBeNull();
    // 负责人 11-19“锁着用甲”：锁屏居中，顶栏“‹ 随手记”（DOM 里排第一）代替原来的“取消”，打开时焦点仍落在主按钮“输入密码”上
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['‹ 随手记', '输入密码']);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('vault-unlock-pin')));
    expect(screen.queryByTestId('vault-unlock-pinview')).toBeNull();
    fireEvent.click(screen.getByTestId('vault-unlock-pin'));
    const view = await screen.findByTestId('vault-unlock-pinview');
    // 隐私记整块收拾 11-20 中 6：换到密码页，焦点放到标题（读屏先念“输入密码”，不留在已经没了的按钮上）
    await waitFor(() => expect(document.activeElement?.hasAttribute('data-unlock-main')).toBe(true));
    expect(document.activeElement?.tagName).toBe('H2');
    expect(screen.getByTestId('vault-unlock-back').textContent).toContain('随手记');
    expect(screen.getByTestId('vault-unlock-cancel').textContent).toBe('取消');
    const pad = screen.getByTestId('vault-unlock-pad');
    const order = [...pad.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'));
    expect(order.indexOf('vault-unlock-pad-dots')).toBeLessThan(order.indexOf('vault-unlock-err'));
    expect(order.indexOf('vault-unlock-err')).toBeLessThan(order.indexOf('vault-unlock-pad-key-0'));
    expect(view.textContent).not.toContain('Ctrl + L');
  });

  it('锁着：只有解锁卡，没有内容；解锁后列出；TC-B5-11 上锁后 DOM 里不留明文', async () => {
    await openUnlocked();
    // B5 隐私记重写：列表跟随手记一样（标题、摘要）；删了的那条不在列表里
    expect(screen.getByTestId('vault-notes').textContent).toContain('体检报告');
    expect(screen.getByTestId('vault-notes').textContent).not.toContain('删掉的');
    act(() => s.lock());
    await screen.findByTestId('vault-unlock-card');
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain('体检报告');
    expect(screen.queryByTestId('vault-notes')).toBeNull();
  });

  it('负责人 11-19 晚“隐私记里面做成跟随手记一样”：#/vault 解锁后直接是随手记那份列表（有分类胶囊、没有宫格首页），顶上“‹ 随手记”回随手记', async () => {
    await openUnlocked();
    expect(await screen.findByTestId(`notes-more-${NID}`)).toBeTruthy();
    expect(screen.getByTestId('notes-filter')).toBeTruthy();
    expect(screen.queryByTestId('vault-home')).toBeNull();
    expect(screen.queryByTestId('vault-back-home')).toBeNull();
    expect(screen.getByTestId('vault-back')).toBeTruthy();
  });

  it('分类胶囊“＋ 新分类”：起名建好筛到这一类（#/vault/c/<id>，空的也留着这一类、胶囊写 0）；同名不再建', async () => {
    cats.rows = [];
    await openUnlocked();
    fireEvent.click(await screen.findByTestId('notes-filter-new'));
    const ok = await screen.findByTestId('cat-new-ok');
    expect(ok.hasAttribute('disabled')).toBe(true);
    const input = screen.getByTestId('cat-new-name');
    // 按字截到 12 个（emoji 也算一个；第三方实测 11-19 问题 5：原来 maxLength 按 UTF-16，emoji 只能输 6 个）
    fireEvent.change(input, { target: { value: '😀😀😀😀😀😀😀😀😀😀😀😀😀😀' } });
    expect([...(input as HTMLInputElement).value]).toHaveLength(12);
    fireEvent.change(input, { target: { value: ' 旅行 ' } });
    fireEvent.click(ok);
    await waitFor(() => expect(window.location.hash).toBe('#/vault/c/new-cat'));
    // 一条都没有的新分类：地址不被换回 all，列表里这一类的胶囊在、写 0
    await new Promise((r) => setTimeout(r, 50));
    expect(window.location.hash).toBe('#/vault/c/new-cat');
    expect(screen.getByTestId('vault-notes').textContent).toContain('旅行');
    cats.rows = [];
  });

  it('独立评审 11-19 中 2：地址就是筛选——#/vault/c/<已经没了的分类> 解锁后原地换成 #/vault/c/all，列表是全部', async () => {
    window.location.hash = '#/vault/c/gone-cat';
    await openUnlocked();
    await waitFor(() => expect(window.location.hash).toBe('#/vault/c/all'));
    expect(await screen.findByTestId(`notes-more-${NID}`)).toBeTruthy();
    expect(screen.getByTestId('vault-back')).toBeTruthy();
  });

  it('随手记那一份“⋯”：移出隐私记走 exportNote；删除立刻从列表拿掉、进隐私记自己的最近删除（后台发 delete）', async () => {
    await openUnlocked();
    const out = vi.spyOn(s, 'exportNote').mockResolvedValue({ ok: true, value: { ok: true, vault_token: 't', expires_at: 0 } });
    fireEvent.click(screen.getByTestId(`notes-more-${NID}`));
    expect(screen.queryByTestId(`notes-to-vault-${NID}`)).toBeNull();
    await act(async () => {
      fireEvent.click(await screen.findByTestId(`notes-from-vault-${NID}`));
    });
    expect(out).toHaveBeenCalledWith(NID);
    fireEvent.click(screen.getByTestId(`notes-more-${NID}`));
    await act(async () => {
      fireEvent.click(await screen.findByTestId(`notes-del-${NID}`));
    });
    expect(s.store.get(NID)?.['deleted_at']).not.toBeNull();
    await waitFor(() => expect(screen.getByTestId('vault-open-trash').getAttribute('aria-label')).toBe('最近删除 2'));
  });

  it('Ctrl+L 立即上锁', async () => {
    await openUnlocked();
    act(() => {
      fireEvent.keyDown(window, { key: 'l', ctrlKey: true });
    });
    expect(s.get().phase).toBe('locked');
  });

  it('TC-B5-13：解锁成功时遮罩加淡出类（--dur-ui），过后卸掉；上锁时遮罩直接出现、没有淡出类', async () => {
    s = session();
    installVaultSession(s);
    render(<VaultPage />);
    // 隐私记页锁着是 LockedPage（不是遮罩，11-19 独立评审高 1）：淡出同一套
    const scrim = await screen.findByTestId('vault-locked');
    expect(scrim.hasAttribute('data-leaving')).toBe(false);
    await act(async () => {
      await s.unlock('1234');
    });
    expect(screen.getByTestId('vault-locked').getAttribute('data-leaving')).toBe('true');
    await waitFor(() => expect(screen.queryByTestId('vault-locked')).toBeNull(), { timeout: 2000 });
    act(() => s.lock());
    expect(screen.getByTestId('vault-locked').hasAttribute('data-leaving')).toBe(false);
    const css = readFileSync(join(import.meta.dirname, '../ui/Vault.module.css'), 'utf8');
    expect(css).toMatch(/\.scrim \{[^}]*transition: opacity var\(--dur-ui\)/);
    expect(css).toMatch(/\.lockOut \{[^}]*transition: opacity var\(--dur-ui\)/);
    expect(css).not.toMatch(/\.shield \{[^}]*transition/);
    expect(css).not.toMatch(/@keyframes/);
  });
});

describe('TC-B5-12：底栏实色、不建副本', () => {
  it('页面挂着时 <html data-solid="1">（系统“减少透明效果”的 data-rt 不动），中途皮肤重画也不被冲掉；卸掉后拿掉', async () => {
    s = session();
    installVaultSession(s);
    const base = { skin: 'glass', theme: 'light', font: 'system' } as const;
    applyLook(base);
    expect(document.documentElement.hasAttribute('data-solid')).toBe(false);
    const r = render(<VaultPage />);
    expect(document.documentElement.getAttribute('data-solid')).toBe('1');
    expect(document.documentElement.hasAttribute('data-rt')).toBe(false);
    applyLook({ ...base, theme: 'dark' });
    expect(document.documentElement.getAttribute('data-solid')).toBe('1');
    r.unmount();
    expect(document.documentElement.hasAttribute('data-solid')).toBe(false);
  });

  it('GlassBar 不 import 隐私记、不持有隐私记数据', () => {
    const dir = join(import.meta.dirname, '../../../kit/components/GlassBar');
    for (const f of readdirSync(dir).filter((n) => /\.(ts|tsx)$/.test(n))) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/vault/i);
  });
});

describe('TC-B5-44：离开时同步盖多任务遮罩', () => {
  it.each(['visibilitychange', 'pagehide', 'blur'] as const)('%s 一到就同步盖上（不等渲染）', async (ev) => {
    await openUnlocked();
    const stop = watchLeave(s, window, () => 0);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    if (ev === 'visibilitychange') document.dispatchEvent(new Event('visibilitychange'));
    else window.dispatchEvent(new Event(ev));
    expect(document.documentElement.getAttribute(SHIELD_ATTR)).toBe('1');
    expect(screen.getByTestId('vault-shield')).toBeTruthy();
    vis.mockRestore();
    stop();
  });

  it('点了选文件框后那次 blur 不盖（负责人 11-20：点图片图标整页被盖住）；回来以后再 blur 照旧盖；选文件时真切后台照旧盖', async () => {
    await openUnlocked();
    const stop = watchLeave(s, window, () => 0);
    const input = document.createElement('input');
    input.type = 'file';
    document.body.append(input);
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    window.dispatchEvent(new Event('blur'));
    expect(document.documentElement.hasAttribute(SHIELD_ATTR)).toBe(false);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    window.dispatchEvent(new Event('blur'));
    expect(document.documentElement.getAttribute(SHIELD_ATTR)).toBe('1');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    window.dispatchEvent(new Event('pagehide'));
    expect(document.documentElement.getAttribute(SHIELD_ATTR)).toBe('1');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    input.remove();
    stop();
  });

  it.each(['change', 'cancel', '定时器'] as const)('隐私记整块收拾 11-20 高 3：点了选文件框、没等到 blur 就 %s——放过的那一次作废，之后的 blur 照常盖遮罩、开始计时', async (how) => {
    await openUnlocked();
    let now = 0;
    const stop = watchLeave(s, window, () => now);
    const input = document.createElement('input');
    input.type = 'file';
    document.body.append(input);
    vi.useFakeTimers();
    try {
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (how === '定时器') vi.advanceTimersByTime(PICK_MS);
      else input.dispatchEvent(new Event(how, { bubbles: how === 'change' }));
    } finally {
      vi.useRealTimers();
    }
    window.dispatchEvent(new Event('blur'));
    expect(document.documentElement.getAttribute(SHIELD_ATTR)).toBe('1');
    now = 61_000;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(s.get().phase).toBe('locked');
    input.remove();
    stop();
  });

  it('59 秒回来：遮罩去掉、仍解锁；61 秒回来：上锁、露出解锁卡', async () => {
    await openUnlocked();
    let now = 0;
    const stop = watchLeave(s, window, () => now);
    window.dispatchEvent(new Event('blur'));
    now = 59_000;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(document.documentElement.hasAttribute(SHIELD_ATTR)).toBe(false);
    expect(s.get().phase).toBe('unlocked');
    now = 100_000;
    window.dispatchEvent(new Event('blur'));
    now = 161_000;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(document.documentElement.hasAttribute(SHIELD_ATTR)).toBe(false);
    expect(s.get().phase).toBe('locked');
    await screen.findByTestId('vault-unlock-card');
    expect(document.body.textContent).not.toContain(SECRET);
    stop();
  });
});

describe('11-18 评审加密组第 3 条（负责人 11-25 选乙）：点进页内预览（iframe）不算离开，文档真失焦再按离开算', () => {
  const shieldOn = (): boolean => document.documentElement.getAttribute(SHIELD_ATTR) === '1';
  /** 焦点在页内 iframe：hasFocus 由 has() 决定，activeElement 由 act() 决定 */
  function focusIn(has: () => boolean, act: () => Element) {
    const a = vi.spyOn(document, 'hasFocus').mockImplementation(has);
    const b = vi.spyOn(document, 'activeElement', 'get').mockImplementation(act);
    return () => {
      a.mockRestore();
      b.mockRestore();
    };
  }
  const frame = (): HTMLIFrameElement => document.body.appendChild(document.createElement('iframe'));
  /** 会话和 watchLeave 用同一个钟（会话按离开时刻挂的上锁计时器在假计时器下也按这个钟算，不会拿真实时刻提前锁） */
  let now = 0;
  const open = (): Promise<void> => {
    now = 0;
    return openUnlocked({ now: () => now });
  };
  /**
   * 换成假时钟，并数还没清掉的查焦点计时器（只认 FRAME_POLL_MS 的 setInterval；会话自己的上锁计时器是 setTimeout，不算）。
   * done() 先放掉两个 spy 再换回真时钟
   */
  function fakeClock(): { polls: () => number; done: () => void } {
    vi.useFakeTimers();
    const si = vi.spyOn(window, 'setInterval');
    const ci = vi.spyOn(window, 'clearInterval');
    return {
      polls: () => si.mock.calls.filter((c, i) => c[1] === FRAME_POLL_MS && !ci.mock.calls.some((d) => d[0] === si.mock.results[i]?.value)).length,
      done: () => {
        si.mockRestore();
        ci.mockRestore();
        vi.useRealTimers();
      },
    };
  }

  it('点进预览那次 blur 不盖、不计时，61 秒还解锁着；hasFocus 变 false 后 0.5 秒内盖上，离开时刻记最后一次看到还在的那一刻，从那一刻满 1 分钟回来上锁', async () => {
    await open();
    let has = true;
    const f = frame();
    const restore = focusIn(() => has, () => f);
    const hide = vi.spyOn(s, 'hide');
    const clock = fakeClock();
    const stop = watchLeave(s, window, () => now);
    try {
      window.dispatchEvent(new Event('blur'));
      expect(shieldOn()).toBe(false);
      for (let t = 0; t < 61_000; t += FRAME_POLL_MS) {
        now += FRAME_POLL_MS;
        vi.advanceTimersByTime(FRAME_POLL_MS);
      }
      expect(shieldOn()).toBe(false);
      expect(hide).not.toHaveBeenCalled();
      expect(s.get().phase).toBe('unlocked');
      has = false;
      now += FRAME_POLL_MS;
      vi.advanceTimersByTime(FRAME_POLL_MS);
      expect(shieldOn()).toBe(true);
      expect(hide).toHaveBeenCalledWith(61_000);
      expect(clock.polls(), '盖上以后接着查回没回来').toBe(1);
      // 回到这个窗口：浏览器把焦点还给 iframe，顶层不收 focus，靠查到 hasFocus 回来；
      // 从最后一次看到还在（61 秒）算满 1 分钟：按发现失焦那一刻（61.5 秒）算就只有 59.5 秒、不会锁
      has = true;
      now = 121_000;
      act(() => {
        vi.advanceTimersByTime(FRAME_POLL_MS);
      });
      expect(s.get().phase).toBe('locked');
      expect(shieldOn()).toBe(false);
    } finally {
      clock.done();
    }
    restore();
    f.remove();
    stop();
  });

  it('切窗口不到 1 分钟回来（焦点还在预览里）：0.5 秒内去掉遮罩、仍解锁，接着查；再切走照样盖上', async () => {
    await open();
    let has = true;
    const f = frame();
    const restore = focusIn(() => has, () => f);
    const clock = fakeClock();
    const stop = watchLeave(s, window, () => now);
    try {
      window.dispatchEvent(new Event('blur'));
      has = false;
      now = 500;
      vi.advanceTimersByTime(FRAME_POLL_MS);
      expect(shieldOn()).toBe(true);
      has = true;
      now = 30_000;
      act(() => {
        vi.advanceTimersByTime(FRAME_POLL_MS);
      });
      expect(shieldOn()).toBe(false);
      expect(s.get().phase).toBe('unlocked');
      expect(clock.polls(), '焦点还在预览里：接着查').toBe(1);
      has = false;
      vi.advanceTimersByTime(FRAME_POLL_MS);
      expect(shieldOn()).toBe(true);
    } finally {
      clock.done();
    }
    restore();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    f.remove();
    stop();
  });

  it('关掉预览回到页面后计时照常：查到焦点回了页面就停查，之后的 blur 立刻盖上、从那一刻满 1 分钟回来上锁', async () => {
    await open();
    let has = true;
    let inside = true;
    const f = frame();
    const restore = focusIn(() => has, () => (inside ? f : document.body));
    const hide = vi.spyOn(s, 'hide');
    const clock = fakeClock();
    const stop = watchLeave(s, window, () => now);
    try {
      window.dispatchEvent(new Event('blur'));
      expect(clock.polls()).toBe(1);
      // 关掉预览：iframe 卸下，焦点落回页面（顶层不一定收到 focus）
      inside = false;
      f.remove();
      now = 5_000;
      vi.advanceTimersByTime(FRAME_POLL_MS);
      expect(clock.polls(), '焦点回了页面：停查').toBe(0);
      expect(shieldOn()).toBe(false);
      now = 10_000;
      has = false;
      window.dispatchEvent(new Event('blur'));
      expect(shieldOn(), '之后的 blur 照旧同步盖上').toBe(true);
      expect(hide).toHaveBeenCalledWith(10_000);
      expect(clock.polls()).toBe(0);
    } finally {
      clock.done();
    }
    has = true;
    now = 69_000;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(s.get().phase, '59 秒回来不锁').toBe('unlocked');
    has = false;
    now = 100_000;
    window.dispatchEvent(new Event('blur'));
    has = true;
    now = 160_000;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(s.get().phase, '满 1 分钟回来上锁').toBe('locked');
    restore();
    stop();
  });

  it('只放过 iframe：焦点不在 iframe、或文档已经没焦点时的 blur 照旧同步盖上', async () => {
    await open();
    const f = frame();
    const stop = watchLeave(s, window, () => now);
    for (const [has, el] of [
      [true, document.body],
      [false, f],
    ] as const) {
      const restore = focusIn(() => has, () => el);
      window.dispatchEvent(new Event('blur'));
      expect(shieldOn(), `hasFocus=${has} activeElement=${el.tagName}`).toBe(true);
      restore();
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(shieldOn()).toBe(false);
    }
    f.remove();
    stop();
  });

  it('焦点在预览里时切后台照旧同步盖上；回到前台焦点还在预览里就接着查，之后切窗口照样盖上', async () => {
    await open();
    let has = true;
    const f = frame();
    const restore = focusIn(() => has, () => f);
    const clock = fakeClock();
    const stop = watchLeave(s, window, () => now);
    try {
      window.dispatchEvent(new Event('blur'));
      expect(clock.polls()).toBe(1);
      const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(shieldOn(), '切后台同步盖上').toBe(true);
      expect(clock.polls(), '切后台停查').toBe(0);
      vis.mockRestore();
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(shieldOn()).toBe(false);
      expect(clock.polls(), '回来焦点还在预览里：接着查').toBe(1);
      has = false;
      vi.advanceTimersByTime(FRAME_POLL_MS);
      expect(shieldOn(), '回来以后切窗口：0.5 秒内盖上').toBe(true);
    } finally {
      clock.done();
    }
    restore();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    f.remove();
    stop();
  });

  it.each(['焦点回到页面', '回来（focus）', '卸下监听', '切后台', 'pagehide'] as const)('%s：查焦点的计时器清掉，不留泄漏', async (how) => {
    await open();
    let inside = true;
    const f = frame();
    const restore = focusIn(() => true, () => (inside ? f : document.body));
    const clock = fakeClock();
    const stop = watchLeave(s, window, () => now);
    let vis: { mockRestore: () => void } | undefined;
    try {
      window.dispatchEvent(new Event('blur'));
      expect(clock.polls()).toBe(1);
      if (how === '焦点回到页面') {
        inside = false;
        vi.advanceTimersByTime(FRAME_POLL_MS);
        expect(shieldOn(), '焦点回到页面不算离开').toBe(false);
      } else if (how === '回来（focus）') {
        inside = false;
        act(() => {
          window.dispatchEvent(new Event('focus'));
        });
      } else if (how === '卸下监听') stop();
      else if (how === '切后台') {
        vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      } else window.dispatchEvent(new Event('pagehide'));
      expect(clock.polls()).toBe(0);
    } finally {
      clock.done();
      vis?.mockRestore();
    }
    restore();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    f.remove();
    stop();
  });
});

describe('TC-B5-33：断网', () => {
  it('锁着时断网：显示“要联网”和重试，没有密码键盘、没有内容', async () => {
    s = session({ offline: true });
    installVaultSession(s);
    render(<VaultPage />);
    await screen.findByTestId('vault-offline');
    expect(screen.queryByTestId('vault-unlock-card')).toBeNull();
    expect(screen.getByTestId('vault-retry')).toBeTruthy();
  });
});

describe('隐私记整块收拾 11-20 高 1：已解锁、列表还没到（记录页、列表页、最近删除都等它）', () => {
  /** 解锁时列表拉不下来：第一次 list 按 first 回，之后照常 */
  async function unlockWithList(hash: string, first: () => unknown) {
    let n = 0;
    s = session({ list: () => (++n === 1 ? first() : LISTED) });
    installVaultSession(s);
    window.location.hash = hash;
    render(<VaultPage />);
    await screen.findByTestId('vault-unlock-card');
    await act(async () => {
      void s.unlock('1234');
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it('记录页：列表还没到时不空白——有隐私记顶栏和“加载中”；到了才出编辑页', async () => {
    let done: (v: unknown) => void = () => undefined;
    await unlockWithList(`#/vault/${NID}`, () => new Promise((r) => (done = r)));
    expect(s.get().phase).toBe('unlocked');
    expect(screen.getByTestId('vault-list-loading').textContent).not.toBe('');
    expect(screen.getByTestId('vault-back')).toBeTruthy();
    expect(screen.queryByTestId('note-edit-body')).toBeNull();
    await act(async () => {
      done(LISTED);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(await screen.findByTestId('note-edit-body', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByTestId('vault-list-loading')).toBeNull();
  });

  it('列表页：拉列表失败写出错和“重试”（顶栏照画），点重试再拉一次、列出', async () => {
    await unlockWithList('#/vault', () => ({ ok: false, code: 'unknown' }));
    const fail = await screen.findByTestId('vault-list-fail');
    expect(fail.querySelector('[role="alert"]')?.textContent).not.toBe('');
    expect(screen.getByTestId('vault-back')).toBeTruthy();
    expect(screen.getByTestId('vault-lock-now')).toBeTruthy();
    fireEvent.click(screen.getByTestId('vault-list-retry'));
    // 随手记那一套是懒加载：单跑这几条时第一次画要多等一会
    expect((await screen.findByTestId('vault-notes', {}, { timeout: 5000 })).textContent).toContain('体检报告');
    expect(screen.queryByTestId('vault-list-fail')).toBeNull();
  });

  it('最近删除：列表没到不画（没有空的“最近删除”页），到了才列出删掉的那条', async () => {
    let done: (v: unknown) => void = () => undefined;
    await unlockWithList('#/vault/trash', () => new Promise((r) => (done = r)));
    expect(screen.getByTestId('vault-list-loading')).toBeTruthy();
    expect(screen.queryByTestId(`vault-trash-row-${GONE}`)).toBeNull();
    await act(async () => {
      done(LISTED);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(await screen.findByTestId(`vault-trash-row-${GONE}`)).toBeTruthy();
  });
});

describe('TC-B5-48 ②：隐私记自己的“最近删除”', () => {
  it('解锁后列出已删的；永久删除先确认，确认后才调 purge', async () => {
    const purge = vi.fn();
    s = session({ purge });
    installVaultSession(s);
    window.location.hash = '#/vault/trash';
    render(<VaultPage />);
    await screen.findByTestId('vault-unlock-card');
    await act(async () => {
      await s.unlock('1234');
    });
    await screen.findByTestId(`vault-trash-row-${GONE}`);
    expect(screen.queryByTestId(`vault-trash-row-${NID}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`vault-purge-${GONE}`));
    expect(purge).not.toHaveBeenCalled();
    await screen.findByTestId('vault-purge-confirm-ok');
    await act(async () => {
      fireEvent.click(screen.getByTestId('vault-purge-confirm-ok'));
    });
    await waitFor(() => expect(purge).toHaveBeenCalledTimes(1));
  });
});

/** 编辑页输入一段字、离开输入框（停笔提交，同随手记编辑页） */
async function type(testId: 'note-edit-title' | 'note-edit-body', value: string) {
  const el = await screen.findByTestId(testId);
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value } });
  await act(async () => {
    fireEvent.blur(el);
    await new Promise((r) => setTimeout(r, 0));
  });
}
const saves = (m: ReturnType<typeof make>) => m.calls.filter((c) => c.action === 'save' && c.token !== null);

describe('11-14 整块评审第 22 条：令牌续不上（超过 12 小时、闲置过期）时编辑页没发完的改动不丢', () => {
  it('打字触发续期被拒 → 换成解锁卡、DOM 里没有草稿；解锁后改动发出去、编辑页还是本机那一份', async () => {
    let renews = 0;
    // 假服务器记住存上的正文（解锁后 list 回的是它）
    let body = SECRET;
    const m = make({
      renew: () => (++renews === 1 ? { ok: false, code: 'vault_locked' } : { ok: true, vault_token: TOK, expires_at: 9e12 }),
      save: (req, tok) => {
        if (!tok) return { ok: false, code: 'vault_locked' };
        if (req.action === 'save') body = req.body;
        return { ok: true, vault_token: TOK, expires_at: 9e12 };
      },
      list: () => ({ ok: true, notes: [note({ body })], vault_token: TOK, expires_at: 9e12 }),
    });
    installVaultSession(m.s);
    window.location.hash = `#/vault/${NID}`;
    render(<VaultPage />);
    await screen.findByTestId('vault-unlock-card');
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    await screen.findByTestId('note-edit-body');
    m.clock.ms += 6 * 60_000;
    await type('note-edit-body', '还没存的正文');
    await screen.findByTestId('vault-unlock-card');
    expect(document.body.textContent).not.toContain('还没存的正文');
    await act(async () => {
      await m.s.unlock('1234');
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(saves(m).some((c) => c.req.action === 'save' && c.req.body === '还没存的正文')).toBe(true));
    expect((await screen.findByTestId('note-edit-body') as HTMLTextAreaElement).value).toBe('还没存的正文');
  });

  it('停笔 800ms 还没到就碰上令牌过期的上锁：编辑页卸下那一刻草稿交给队列，解锁后照常发；DOM 里不留草稿', async () => {
    let renews = 0;
    let body = SECRET;
    const m = make({
      renew: () => (++renews === 1 ? { ok: false, code: 'vault_locked' } : { ok: true, vault_token: TOK, expires_at: 9e12 }),
      save: (req, tok) => {
        if (!tok) return { ok: false, code: 'vault_locked' };
        if (req.action === 'save') body = req.body;
        return { ok: true, vault_token: TOK, expires_at: 9e12 };
      },
      list: () => ({ ok: true, notes: [note({ body })], vault_token: TOK, expires_at: 9e12 }),
    });
    installVaultSession(m.s);
    window.location.hash = `#/vault/${NID}`;
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    const el = await screen.findByTestId('note-edit-body');
    // 只敲字、不失焦、不等停笔：草稿还在输入框里没交
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '停笔前的字' } });
    m.clock.ms += 6 * 60_000;
    await act(async () => {
      m.s.touch();
      await new Promise((r) => setTimeout(r, 0));
    });
    await screen.findByTestId('vault-unlock-card');
    expect(document.body.textContent).not.toContain('停笔前的字');
    await act(async () => {
      await m.s.unlock('1234');
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(saves(m).some((c) => c.req.action === 'save' && c.req.body === '停笔前的字')).toBe(true));
    expect((await screen.findByTestId('note-edit-body') as HTMLTextAreaElement).value).toBe('停笔前的字');
  });

  it('主动上锁（作废在飞请求的上锁）时停笔还没到的字：不交、不发（安全优先，同上锁丢队列）', async () => {
    const m = make();
    installVaultSession(m.s);
    window.location.hash = `#/vault/${NID}`;
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    const el = await screen.findByTestId('note-edit-body');
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '锁前没停笔' } });
    await act(async () => {
      m.s.lock();
      await new Promise((r) => setTimeout(r, 0));
    });
    await screen.findByTestId('vault-unlock-card');
    await act(async () => {
      await m.s.unlock('1234');
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(m.calls.some((c) => c.action === 'save' && c.req.action === 'save' && c.req.body === '锁前没停笔')).toBe(false);
    expect(m.s.queue.size()).toBe(0);
  });
});

describe('B5 隐私记重写：停笔自动存、读写只碰内存仓库', () => {
  it('新建：停笔就进列表（不等服务器），后台发一次 save；没有“保存”按钮', async () => {
    const m = make();
    installVaultSession(m.s);
    window.location.hash = '#/vault/new';
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    await type('note-edit-body', '新记的一条');
    expect(screen.queryByTestId('vault-edit-save')).toBeNull();
    expect(m.s.store.getSnapshot().notes.some((n) => n['body'] === '新记的一条')).toBe(true);
    await waitFor(() => expect(saves(m)).toHaveLength(1));
    expect(saves(m)[0]?.req).toMatchObject({ body: '新记的一条' });
  });

  it('保存碰上令牌过期 → 出解锁卡 → 解锁：只重发那一次，不多存', async () => {
    let n = 0;
    const m = make({ save: () => (++n === 1 ? { ok: false, code: 'vault_locked' } : { ok: true, vault_token: TOK, expires_at: 9e12 }) });
    installVaultSession(m.s);
    window.location.hash = '#/vault/new';
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    await type('note-edit-body', '只存一次');
    await screen.findByTestId('vault-unlock-card');
    await act(async () => {
      await m.s.unlock('1234');
      await new Promise((r) => setTimeout(r, 10));
    });
    await waitFor(() => expect(m.calls.filter((c) => c.action === 'save')).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.calls.filter((c) => c.action === 'save')).toHaveLength(2);
  });

  it('审查第 1 条：令牌过期时解锁卡点“取消”：队列整个丢掉；再解锁不补发，列表出“有 1 处改动没来得及保存”', async () => {
    let n = 0;
    const m = make({ save: () => (++n === 1 ? { ok: false, code: 'vault_locked' } : { ok: true, vault_token: TOK, expires_at: 9e12 }) });
    installVaultSession(m.s);
    window.location.hash = '#/vault/new';
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    await type('note-edit-body', '没存上的');
    await screen.findByTestId('vault-unlock-card');
    expect(m.s.get().waiting).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('vault-unlock-cancel'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(m.s.get().waiting).toBe(false);
    expect(m.s.store.getSnapshot().dropped).toBe(1);
    window.location.hash = '#/vault';
    await act(async () => {
      await m.s.unlock('1234');
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(m.calls.filter((c) => c.action === 'save')).toHaveLength(1);
    expect((await screen.findByTestId('notes-sync-dropped')).textContent).toContain('1');
  });

  it('负责人“插图打不开”：编辑页插一张图 → 立刻显示本机那一份；传好了点它出看图页', async () => {
    const m = make();
    installVaultSession(m.s);
    window.location.hash = `#/vault/${NID}`;
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    await screen.findByTestId('note-edit-body');
    await act(async () => {
      fireEvent.change(screen.getByTestId('note-edit-img-input'), { target: { files: [new File([new Uint8Array(5)], 'a.jpg', { type: 'image/jpeg' })] } });
      await new Promise((r) => setTimeout(r, 0));
    });
    const imgId = m.s.store.getSnapshot().images[0]?.id ?? '';
    expect(imgId).not.toBe('');
    await waitFor(() => expect(screen.getByTestId(`note-image-${imgId}`).getAttribute('data-state')).toBe('done'));
    expect(vi.mocked(m.api.imageUpload).mock.calls.map((c) => c[0].part)).toEqual(['full', 'thumb']);
    fireEvent.click(screen.getByTestId(`note-image-open-${imgId}`));
    expect(await screen.findByTestId(`img-view-pic-${imgId}`)).toBeTruthy();
    expect(m.api.imageGet).not.toHaveBeenCalled();
  });

  it('列表封面只取看得见的：没进视口的卡片不发 vault-image', async () => {
    const seen = new Set<Element>();
    const observers: { cb: IntersectionObserverCallback; els: Element[] }[] = [];
    class FakeIO {
      constructor(cb: IntersectionObserverCallback) {
        observers.push({ cb, els: [] });
      }
      observe(el: Element) {
        observers.at(-1)?.els.push(el);
        seen.add(el);
      }
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);
    const pic = { id: GONE, has_thumb: true, width: 10, height: 6, bytes: 3, deleted_at: null };
    const m = make({ list: () => ({ ok: true, notes: [note({ images: [pic] })], vault_token: TOK, expires_at: 9e12 }) });
    installVaultSession(m.s);
    window.location.hash = '#/vault/c/all';
    render(<VaultPage />);
    await act(async () => {
      await m.s.refreshStatus();
      await m.s.unlock('1234');
    });
    await screen.findByTestId('vault-notes');
    await new Promise((r) => setTimeout(r, 10));
    expect(m.api.imageGet).not.toHaveBeenCalled();
    expect(seen.size).toBeGreaterThan(0);
    await act(async () => {
      for (const o of observers) o.cb(o.els.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry), {} as IntersectionObserver);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(m.api.imageGet).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });
});

describe('审查第 6 条（11-19 改）：隐私记页锁着是一整页（不是遮罩），有标题、焦点在主按钮上', () => {
  it('锁着：一个 h1“隐私记”、h2“隐私记已上锁”；不是对话框；焦点在“输入密码”；Esc 回随手记', async () => {
    s = session();
    installVaultSession(s);
    render(<VaultPage />);
    const page = await screen.findByTestId('vault-locked');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['隐私记']);
    expect(screen.getByRole('heading', { level: 2, name: '隐私记已上锁' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('vault-unlock-pin')));
    // 页面自己的顶栏不画，返回在锁着页里
    expect(screen.queryByTestId('vault-back')).toBeNull();
    expect(page.contains(screen.getByTestId('vault-unlock-cancel'))).toBe(true);
    // Esc 照旧是“取消”（层栈接住后交给卡片的 cancel）：回随手记
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(window.location.hash).toBe('#/notes'));
  });
});

describe('层栈整块评审第 1 条：锁屏是模态层，页面快捷键收不到；数字键只给锁屏里的键盘', () => {
  it('锁着、输密码页：Ctrl+K 等页面的键不响应；数字键进锁屏的键盘；页面上另一个键盘收不到', async () => {
    const page = vi.fn();
    const behind = vi.fn();
    function PageKeys() {
      useKeys({ 'mod+k': () => (page(), true), '5': () => (behind(), true) });
      return null;
    }
    s = session();
    installVaultSession(s);
    render(
      <>
        <VaultPage />
        <PageKeys />
      </>,
    );
    fireEvent.click(await screen.findByTestId('vault-unlock-pin'));
    const dots = await screen.findByTestId('vault-unlock-pad-dots');
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(page).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: '5' });
    expect(behind).not.toHaveBeenCalled();
    expect(dots.getAttribute('data-n')).toBe('1');
    expect(document.documentElement.classList.contains('scroll-locked'), '锁屏不锁滚动（取消时直接换页，webkit View Transition 崩溃）').toBe(false);
  });
});

describe('随手记页的入口行（lockrow）不写条数（负责人 11-15：“不管解锁没解锁里面几条这个不用显示”）', () => {
  it('锁着写“已上锁”、解锁后写“已解锁”，都不带“N 条”', async () => {
    s = session();
    installVaultSession(s);
    render(<VaultParts part="lockrow" />);
    const row = await screen.findByTestId('vault-lockrow');
    await waitFor(() => expect(row.textContent).toContain('已上锁'));
    expect(row.textContent).not.toMatch(/\d+\s*条/);
    await act(async () => {
      await s.unlock('1234');
    });
    await waitFor(() => expect(row.textContent).toContain('已解锁'));
    expect(row.textContent).not.toMatch(/\d+\s*条/);
  });
});

describe('批 2 第 3 条：移出隐私记没成，提示是自己那一条（不借转换结果的 notes-conv-tip）', () => {
  it('export 被拒：输入行上面出“没移出去，稍后再试一次”，testid 是 notes-moveout-tip', async () => {
    window.location.hash = '#/vault/c/all';
    await openUnlocked({ exportFail: true });
    fireEvent.pointerDown(screen.getByTestId(`notes-more-${NID}`), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByTestId(`notes-more-${NID}`));
    fireEvent.click(await screen.findByTestId(`notes-from-vault-${NID}`));
    expect((await screen.findByTestId('notes-moveout-tip')).textContent).toBe('没移出去，稍后再试一次');
    expect(screen.queryByTestId('notes-conv-tip')).toBeNull();
  });
});
