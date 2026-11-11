// App 挂提醒（续）：REMIND-arm-low L1（入口没挂 watchRoot、告知页之后要等 App 自己的功能页）、L3（卸载后不再排等空闲，拦 Y4）；
// 接线审查⑥ L3 硬上限 REMIND_MAX_WAIT_MS（页面一直不提交也挂上、空闲先到取消定时器、切页不重新计时）
// 替身和复位在 app-remind-host-fixture.tsx（必须第一个 import）
import { App, CAP_ID, REMIND_MAX_WAIT_MS, capQ, frameQ, idleQ, life, pageThenIdle, resetRootPaintForTest, runCap, runFrame, runIdle, setTodayPage, settle, st, stopWatch, stopped } from './app-remind-host-fixture.tsx';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// 挂整个 App：全量跑、机器忙时默认 5 秒不够
vi.setConfig({ testTimeout: 15_000 });

describe('App 挂提醒：告知页之后、卸载、硬上限（REMIND-arm-low、接线审查⑥ L3）', () => {
  it('REMIND-arm-firstpaint / arm-low L1：入口没挂 watchRoot（测试、别的入口）时当场算画完，但还要等 App 自己的功能页出来才排等空闲', async () => {
    stopWatch();
    resetRootPaintForTest();
    st.userId = 'user-a';
    setTodayPage('pending');
    render(<App />);
    await settle();
    expect(idleQ).toHaveLength(0);
    await act(async () => {
      st.releasePage();
    });
    await screen.findByRole('main', {}, { timeout: 10_000 });
    await waitFor(() => expect(idleQ).toHaveLength(1), { timeout: 10_000 });
    // 不用再等一帧（first-paint 已经算画完了）
    expect(frameQ).toHaveLength(0);
    runIdle();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
  });

  /** 告知页：App 之前先画一个 main[data-feature="onboarding"]，过了那一帧 first-paint 就算画完；点同意后告知页卸掉、App 第一次渲染 */
  async function passConsent(): Promise<void> {
    const consent = document.createElement('main');
    consent.setAttribute('data-feature', 'onboarding');
    document.body.appendChild(consent);
    await waitFor(() => expect(frameQ).toHaveLength(1), { timeout: 10_000 });
    runFrame();
    consent.remove();
  }

  it('arm-low L1：告知页之后 App 第一次渲染：不当场等空闲，等今天页（App 自己的功能页）出来才排，空闲后挂', async () => {
    await passConsent();
    st.userId = 'user-a';
    setTodayPage('pending');
    render(<App />);
    await settle();
    expect(screen.queryByRole('main')).toBeNull();
    expect(idleQ).toHaveLength(0);
    expect(screen.queryByTestId('fake-host')).toBeNull();
    await act(async () => {
      st.releasePage();
    });
    expect((await screen.findByRole('main', {}, { timeout: 10_000 })).getAttribute('data-feature')).toBe('today');
    await waitFor(() => expect(idleQ).toHaveLength(1), { timeout: 10_000 });
    runIdle();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
  });

  it('arm-low L1：告知页之后今天页一直不出来：靠 5 秒硬上限挂上；卸载以后不再看 DOM（后来出现的功能页不会再排等空闲）', async () => {
    await passConsent();
    st.userId = 'user-a';
    setTodayPage('pending');
    render(<App />);
    await settle();
    runCap();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
    expect(idleQ).toHaveLength(0);
    cleanup();
    const later = document.createElement('main');
    later.setAttribute('data-feature', 'today');
    document.body.appendChild(later);
    await settle();
    expect(idleQ).toHaveLength(0);
    later.remove();
  });

  it('arm-low L1：告知页之后卸载 App（等功能页那一段停掉）：后来出现的功能页不再排等空闲', async () => {
    await passConsent();
    st.userId = 'user-a';
    setTodayPage('pending');
    render(<App />);
    await settle();
    cleanup();
    const later = document.createElement('main');
    later.setAttribute('data-feature', 'today');
    document.body.appendChild(later);
    await settle();
    expect(idleQ).toHaveLength(0);
    later.remove();
  });

  it('arm-low L3：页面出来、那一帧还没过时 App 卸载；之后 first-paint 放行，不再排等空闲（cancelled，拦变异 Y4）', async () => {
    st.userId = 'user-a';
    render(<App />);
    await screen.findByRole('main', {}, { timeout: 10_000 });
    await waitFor(() => expect(frameQ).toHaveLength(1), { timeout: 10_000 });
    cleanup();
    runFrame();
    await settle();
    expect(idleQ).toHaveLength(0);
    expect(life).toEqual([]);
  });

  it('L3：页面一直不提交也有硬上限：REMIND_MAX_WAIT_MS 一到就挂上提醒（从 App 第一次渲染算起）', async () => {
    st.userId = 'user-a';
    setTodayPage('pending');
    render(<App />);
    await settle();
    expect(REMIND_MAX_WAIT_MS).toBe(5000);
    expect(capQ).toHaveLength(1);
    expect(idleQ).toHaveLength(0);
    expect(screen.queryByTestId('fake-host')).toBeNull();
    runCap();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
    // 页面还是没画出来
    expect(screen.queryByRole('main')).toBeNull();
  });

  it('L3：空闲先到、已经挂上了，硬上限的定时器取消（不重复挂）', async () => {
    st.userId = 'user-a';
    render(<App />);
    await pageThenIdle();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
    expect(stopped).toEqual([CAP_ID]);
    runCap();
    expect(life).toEqual(['mount:user-a:today']);
  });
  it('N1：页面一直不提交时切页，硬上限不重新计时（还是那一个定时器，没被取消）', async () => {
    st.userId = 'user-a';
    setTodayPage('pending');
    render(<App />);
    await settle();
    expect(capQ).toHaveLength(1);
    await act(async () => {
      window.location.hash = '#/notes';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await settle();
    expect(capQ).toHaveLength(1);
    expect(stopped).toEqual([]);
    runCap();
    await screen.findByTestId('fake-host', {}, { timeout: 10_000 });
  });
});
