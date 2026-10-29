// 倾斜授权试验页 /app/diag/tilt.html（R-153，架构 0.27 第 5 点；TC-B1-54、TC-B1-55；iPhone 实机验收清单 P1-05）
// • 响应头：Permissions-Policy 里 accelerometer、gyroscope 是 (self)，其余关闭；CSP 和 /app/* 一样（构建层的同一组断言在 tests/build/auth-headers.test.ts）
// • 带 CSP 打开页面没有任何 CSP 报错（csp-fixture 自动收）
// • 加载时不调 requestPermission，只在点按回调里调；读数只放内存（不写任何存储、不发页面自己文件以外的请求）
// 桌面浏览器没有 requestPermission、也没有方向传感器：用 addInitScript 在两个构造函数上挂假的 requestPermission 记次数，
// 用普通 Event 加上 beta / gamma 字段模拟 deviceorientation（WebKit 的 Windows 版不一定有 DeviceOrientationEvent 构造函数）。
import { expect, test } from './csp-fixture.ts';

const PAGE = '/app/diag/tilt.html';

declare global {
  interface Window {
    __permCalls?: string[];
  }
}

test.describe('倾斜授权试验页', () => {
  test('TC-B1-54：响应头里 accelerometer、gyroscope 为 (self)，其余设备能力关闭；CSP 只许同源脚本和样式', async ({ request }) => {
    for (const path of [PAGE, '/app/diag/tilt']) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      const raw = res.headers()['permissions-policy'] ?? '';
      const pp = raw.split(',').map((s) => s.trim());
      // 只放给本源（self），不放给任何来源（*）
      expect(raw, path).not.toContain('*');
      for (const want of ['accelerometer=(self)', 'gyroscope=(self)', 'magnetometer=()', 'payment=()', 'usb=()', 'camera=()', 'geolocation=()']) {
        expect(pp, `${path} ${want}`).toContain(want);
      }
      const csp = res.headers()['content-security-policy'] ?? '';
      expect(csp, path).toContain("script-src 'self';");
      expect(csp, path).toContain("style-src 'self';");
      expect(csp, path).not.toContain('unsafe-inline');
    }
  });

  test.describe('页面', () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        window.__permCalls = [];
        const stub = (name: string) => () => {
          window.__permCalls?.push(name);
          return Promise.resolve('granted');
        };
        const w = window as unknown as Record<string, unknown>;
        for (const name of ['DeviceOrientationEvent', 'DeviceMotionEvent']) {
          if (typeof w[name] !== 'function') w[name] = function Fake() {};
          Object.defineProperty(w[name] as object, 'requestPermission', { value: stub(name), configurable: true });
        }
      });
    });

    test('TC-B1-55：加载时不调 requestPermission；没点按就收到读数判“记得住”；点按时两个接口都调', async ({ page, baseURL }) => {
      const requests: string[] = [];
      page.on('request', (r) => requests.push(r.url()));
      await page.goto(PAGE);
      await expect(page.locator('#env')).toContainText('要（有 requestPermission）');
      expect(await page.evaluate(() => window.__permCalls)).toEqual([]);

      await page.evaluate(() => {
        const e = new Event('deviceorientation');
        Object.assign(e, { alpha: 10, beta: 30, gamma: -10 });
        window.dispatchEvent(e);
      });
      await expect(page.locator('#auto')).toHaveAttribute('data-verdict', 'kept');
      await expect(page.locator('#live')).toContainText('30.0°');
      expect(await page.evaluate(() => window.__permCalls)).toEqual([]);

      await page.getByRole('button', { name: '请求“动作与方向”授权' }).click();
      expect(await page.evaluate(() => window.__permCalls)).toEqual(['DeviceOrientationEvent', 'DeviceMotionEvent']);
      await expect(page.locator('#perm')).toContainText('DeviceOrientationEvent允许（granted）');
      await expect(page.locator('#perm')).toContainText('DeviceMotionEvent允许（granted）');

      // 读数只放内存：没写任何存储，除了本页自己的三个文件（和浏览器自动要的 favicon）没有别的请求
      const stored = await page.evaluate(async () => ({
        local: localStorage.length,
        session: sessionStorage.length,
        cookie: document.cookie,
        idb: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
      }));
      expect(stored).toEqual({ local: 0, session: 0, cookie: '', idb: 0 });
      const origin = new URL(baseURL ?? '').origin;
      const others = requests.filter((u) => !/^\/app\/diag\/tilt(\.html|\.js|\.css)?$/.test(new URL(u).pathname) && new URL(u).pathname !== '/favicon.ico');
      expect(others).toEqual([]);
      expect(requests.every((u) => new URL(u).origin === origin)).toBe(true);
    });

    test('打开后 2 秒内没读数：判“记不住”', async ({ page }) => {
      await page.goto(PAGE);
      await expect(page.locator('#auto')).toHaveAttribute('data-verdict', 'lost', { timeout: 5000 });
      await expect(page.locator('#auto')).toContainText('授权不在 → 记不住');
      expect(await page.evaluate(() => window.__permCalls)).toEqual([]);
    });
  });
});
