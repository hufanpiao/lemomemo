// Turnstile（15.2 中 1 ①）：站点密钥的配置位、测试密钥的桩、脚本只加载一次
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TURNSTILE_SCRIPT,
  TURNSTILE_TEST_SITEKEY,
  isTestSiteKey,
  loadTurnstile,
  mountTurnstile,
  resetTurnstileLoaderForTest,
  turnstileSiteKey,
  type TurnstileApi,
} from '../turnstile.ts';

afterEach(() => {
  resetTurnstileLoaderForTest();
  delete window.turnstile;
  document.head.querySelectorAll('script').forEach((s) => s.remove());
});

describe('站点密钥', () => {
  it('给了就用给的（负责人换成正式值的地方：VITE_PUBLIC_TURNSTILE_SITE_KEY）', () => {
    expect(turnstileSiteKey({ turnstileSiteKey: 'fake-sitekey-for-test', env: 'production' })).toBe('fake-sitekey-for-test');
    expect(turnstileSiteKey({ turnstileSiteKey: 'fake-sitekey-for-test', env: 'preview' })).toBe('fake-sitekey-for-test');
  });

  it('没给：本机、预览退回 Cloudflare 官方测试密钥做桩；正式版报错', () => {
    expect(turnstileSiteKey({ turnstileSiteKey: '', env: 'development' })).toBe(TURNSTILE_TEST_SITEKEY);
    expect(turnstileSiteKey({ turnstileSiteKey: '', env: 'preview' })).toBe(TURNSTILE_TEST_SITEKEY);
    expect(() => turnstileSiteKey({ turnstileSiteKey: '', env: 'production' })).toThrow('turnstile_sitekey_missing');
  });

  it('正式版运行时也挡测试密钥（安全审查 6）；首尾空白先去掉再判断', () => {
    expect(() => turnstileSiteKey({ turnstileSiteKey: TURNSTILE_TEST_SITEKEY, env: 'production' })).toThrow('turnstile_test_sitekey_in_production');
    expect(() => turnstileSiteKey({ turnstileSiteKey: ` ${TURNSTILE_TEST_SITEKEY}\n`, env: 'production' })).toThrow('turnstile_test_sitekey_in_production');
    expect(() => turnstileSiteKey({ turnstileSiteKey: '   ', env: 'production' })).toThrow('turnstile_sitekey_missing');
    expect(turnstileSiteKey({ turnstileSiteKey: ' fake-sitekey-for-test ', env: 'production' })).toBe('fake-sitekey-for-test');
    // 预览、本机照样可以用测试密钥做桩
    expect(turnstileSiteKey({ turnstileSiteKey: TURNSTILE_TEST_SITEKEY, env: 'preview' })).toBe(TURNSTILE_TEST_SITEKEY);
    expect(turnstileSiteKey({ turnstileSiteKey: '  ', env: 'preview' })).toBe(TURNSTILE_TEST_SITEKEY);
  });

  it('vite.config.ts 先 trim 再判断', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const cfg = readFileSync(join(import.meta.dirname, '../../../vite.config.ts'), 'utf8');
    expect(cfg).toContain("(process.env.VITE_PUBLIC_TURNSTILE_SITE_KEY ?? '').trim()");
  });

  it('认得出官方测试密钥（vite.config.ts 用同一个规则挡正式版）', () => {
    expect(isTestSiteKey(TURNSTILE_TEST_SITEKEY)).toBe(true);
    expect(isTestSiteKey('2x00000000000000000000AB')).toBe(true);
    expect(isTestSiteKey('3x00000000000000000000FF')).toBe(true);
    expect(isTestSiteKey('fake-sitekey-for-test')).toBe(false);
  });

  it('vite.config.ts 里挡正式版的正则和 isTestSiteKey 一致', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const cfg = readFileSync(join(import.meta.dirname, '../../../vite.config.ts'), 'utf8');
    expect(cfg).toContain('/^[1-3]x0{20}[A-Z]{2}$/');
  });
});

describe('加载脚本', () => {
  function fakeApi(): TurnstileApi {
    return { render: vi.fn(() => 'w1'), reset: vi.fn(), remove: vi.fn() };
  }

  it('只插一次 challenges.cloudflare.com 的脚本（explicit 模式），load 以后拿到 window.turnstile', async () => {
    const a = loadTurnstile();
    const b = loadTurnstile();
    const scripts = document.head.querySelectorAll('script');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.src).toBe(TURNSTILE_SCRIPT);
    const api = fakeApi();
    window.turnstile = api;
    scripts[0]?.dispatchEvent(new Event('load'));
    await expect(a).resolves.toBe(api);
    await expect(b).resolves.toBe(api);
  });

  it('加载失败：报错，下次再调会重新插脚本', async () => {
    const p = loadTurnstile();
    document.head.querySelector('script')?.dispatchEvent(new Event('error'));
    await expect(p).rejects.toThrow('turnstile_load_failed');
    void loadTurnstile().catch(() => undefined);
    expect(document.head.querySelectorAll('script')).toHaveLength(2);
  });

  it('mountTurnstile：用配置的站点密钥画小窗，reset、remove 指向同一个小窗', async () => {
    const api = fakeApi();
    window.turnstile = api;
    const el = document.createElement('div');
    const w = await mountTurnstile(el, { language: 'ko' });
    expect(api.render).toHaveBeenCalledWith(el, expect.objectContaining({ sitekey: TURNSTILE_TEST_SITEKEY, language: 'ko' }));
    w.reset();
    w.remove();
    expect(api.reset).toHaveBeenCalledWith('w1');
    expect(api.remove).toHaveBeenCalledWith('w1');
  });
});
