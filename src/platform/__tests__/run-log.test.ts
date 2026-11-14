// 全局运行日志（负责人 11-11“以后所有的bug看log能不能解决”“要做就给我做详细的log”，platform/run-log.ts）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KB_CHECK_MS, MAX_LINES, OUT_KEY, readRunLog, startRunLog } from '../run-log.ts';
import { describeEl } from '../run-log-layout.ts';
import { rlog, RL_SLOT } from '../run-log-api.ts';

const mkField = () => {
  const form = document.createElement('form');
  form.setAttribute('data-testid', 'type-bar');
  const input = document.createElement('input');
  input.setAttribute('data-testid', 'type-input');
  input.value = '秘密内容';
  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.setAttribute('aria-label', '记下');
  btn.textContent = '记下';
  form.append(input, btn);
  form.addEventListener('submit', (e) => e.preventDefault());
  document.body.append(form);
  return { form, input, btn };
};

describe('全局运行日志', () => {
  afterEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-kbo');
    delete (globalThis as Record<string, unknown>)[RL_SLOT];
    vi.useRealTimers();
  });

  it('开头、boot 版面快照；焦点（点出来还是程序聚焦、长度）、点按、回车（表单、提交按钮禁没禁用）、提交、键盘标记、报错各记一行；不记输入的文字', async () => {
    vi.useFakeTimers();
    const { input, btn, form } = mkField();
    const stop = startRunLog(window, { version: 'test' });
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    btn.disabled = true;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    btn.disabled = false;
    btn.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    form.requestSubmit(btn);
    document.documentElement.setAttribute('data-kbo', '1');
    await vi.advanceTimersByTimeAsync(500);
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'https://x/a.js', lineno: 3, colno: 7 }));
    stop();
    const log = readRunLog();
    expect(log).toMatch(/=== start .* v=test/);
    expect(log).toMatch(/boot inner=.*\[bar=none .*type=/);
    expect(log).toMatch(/focusin input\[text\]#type-input by=code len=4 sel=/);
    expect(log).toMatch(/key Enter code=13 on=input\[text\]#type-input form=form#type-bar submitBtn=enabled len=4/);
    expect(log).toMatch(/key Enter code=13 on=input\[text\]#type-input form=form#type-bar submitBtn=disabled/);
    expect(log).toMatch(/key char /);
    expect(log).toMatch(/down button#记下 /);
    expect(log).toMatch(/submit form#type-bar by=button#记下/);
    expect(log).toMatch(/root kbo=1/);
    expect(log).toMatch(/settled\(focusin\)/);
    expect(log).toMatch(/error boom @a\.js:3:7/);
    expect(log).not.toContain('秘密内容');
  });

  it('点按被后挂的捕获监听 preventDefault（例如换页后吞点按的窗口）：派发完补记 prevented-later；没被拦的不补（推进计划 7b）', async () => {
    vi.useFakeTimers();
    const { btn } = mkField();
    const stop = startRunLog(window, { version: 't' });
    let eat = true;
    const guard = (e: Event): void => {
      if (eat) e.preventDefault();
    };
    document.addEventListener('pointerdown', guard, true);
    document.addEventListener('click', guard, true);
    btn.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    eat = false;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(500);
    document.removeEventListener('pointerdown', guard, true);
    document.removeEventListener('click', guard, true);
    stop();
    const log = readRunLog();
    expect(log).toMatch(/down button#记下 prevented-later/);
    expect(log.match(/click button#记下 prevented-later/g)).toHaveLength(1);
    expect(log.match(/click button#记下$/gm)).toHaveLength(2);
  });

  it('业务代码 rlog：下载前排队的补进来，之后直接写', () => {
    rlog('typebar submit len=3');
    const stop = startRunLog(window, { version: 't' });
    rlog('typebar stored out=ok');
    stop();
    const log = readRunLog();
    expect(log).toMatch(/app typebar submit len=3/);
    expect(log).toMatch(/app typebar stored out=ok/);
  });

  it('离开页面（pagehide，例如启动失败跳登录页的 location.replace）当场存盘，不等 300ms（第三方审查前端第 3 条）', () => {
    vi.useFakeTimers();
    const stop = startRunLog(window, { version: 't' });
    vi.advanceTimersByTime(1000);
    rlog('boot start_failed TypeError -> auth');
    expect(readRunLog()).not.toMatch(/boot start_failed/);
    window.dispatchEvent(new Event('pagehide'));
    expect(readRunLog()).toMatch(/app boot start_failed TypeError -> auth/);
    stop();
  });

  it('网络请求记方法、路径（不带参数）、状态；失败记 FAIL', async () => {
    const orig = window.fetch;
    let fail = false;
    window.fetch = vi.fn(async () => {
      if (fail) throw new TypeError('net');
      return new Response('', { status: 403 });
    }) as typeof fetch;
    try {
      const stop = startRunLog(window, { version: 't' });
      await window.fetch('/sb/rest/v1/notes?select=secret', { method: 'POST' });
      fail = true;
      await expect(window.fetch('/sb/x')).rejects.toThrow();
      stop();
      const log = readRunLog();
      expect(log).toMatch(/net POST \/sb\/rest\/v1\/notes 403 \d+ms/);
      expect(log).toMatch(/net GET \/sb\/x FAIL TypeError/);
      expect(log).not.toContain('secret');
    } finally {
      window.fetch = orig;
    }
  });

  it('console.error 记下来，原来的照样调用；停止后还原', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stop = startRunLog(window, { version: 't' });
    console.error(new Error('bad thing'));
    stop();
    expect(readRunLog()).toMatch(/console\.error Error: bad thing/);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('跨冷启动保留旧日志，超过 MAX_LINES 丢最旧的', () => {
    localStorage.setItem(OUT_KEY, Array.from({ length: MAX_LINES + 50 }, (_, i) => `old${i}`).join('\n'));
    startRunLog(window, { version: 'v2' })();
    const lines = readRunLog().split('\n');
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(lines.some((l) => l.includes('v=v2'))).toBe(true);
    expect(lines[0]).not.toBe('old0');
  });

  // 台账 Q-8：真机一次就能看出成没成——系统滚没滚页面（dy）、浮条贴没贴键盘（dock）、输入框在不在可视区里（fieldIn）
  it('焦点进来后 400ms、KB_CHECK_MS 各记一行 kbcheck：dy = 文档滚了多少、dtop = 可视区平移了多少，top、dock、fieldIn；马上换路由也照样记', async () => {
    vi.useFakeTimers();
    const own = (k: string) => Object.getOwnPropertyDescriptor(window, k);
    const saved = { visualViewport: own('visualViewport'), scrollY: own('scrollY') };
    const vv = { height: 480, offsetTop: 0, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 100, configurable: true, writable: true });
    const { form, input } = mkField();
    form.style.position = 'fixed';
    const rect = (top: number, bottom: number) => () => ({ top, bottom, height: bottom - top }) as DOMRect;
    form.getBoundingClientRect = rect(330, 474);
    input.getBoundingClientRect = rect(350, 394);
    try {
      const stop = startRunLog(window, { version: 't' });
      input.focus();
      window.dispatchEvent(new HashChangeEvent('hashchange')); // 换路由重设的是 settled 快照的计时器，kbcheck 不受影响
      await vi.advanceTimersByTimeAsync(500);
      // 之后系统把页面滚了 353、可视区下移 291：浮条留在布局视口里，相对可视区跑到上面去了
      Object.defineProperty(window, 'scrollY', { value: 453, configurable: true, writable: true });
      vv.offsetTop = 291;
      await vi.advanceTimersByTimeAsync(KB_CHECK_MS);
      stop();
      const checks = readRunLog().split('\n').filter((l) => l.includes(' kbcheck '));
      expect(checks).toHaveLength(2);
      expect(checks[0]).toMatch(/kbcheck dy=0 dtop=0 top=0 dock=6 fieldIn=1$/);
      expect(checks[1]).toMatch(/kbcheck dy=353 dtop=291 top=291 dock=297 fieldIn=1$/);
    } finally {
      for (const [k, d] of Object.entries(saved)) {
        if (d) Object.defineProperty(window, k, d);
        else Reflect.deleteProperty(window, k);
      }
    }
  });

  it('describeEl 只给标签、type、testid / aria-label / id', () => {
    const b = document.createElement('button');
    b.textContent = '用户文字';
    expect(describeEl(b)).toBe('button');
    b.setAttribute('aria-label', '收起');
    expect(describeEl(b)).toBe('button#收起');
    expect(describeEl(null)).toBe('-');
  });
});
