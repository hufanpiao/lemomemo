// B4b-1 预览沙箱（架构 5.13 第 3 点、架构约定 9.7）：在 App 的来源下嵌 sandbox="allow-scripts"（不给 allow-same-origin）的 /app/preview，
// 经 postMessage 交字节进去，四种本机预览（PDF、Word、Excel、PPT 退路）都渲染出来；ZIP 炸弹在沙箱里被拒；沙箱读不到 App 的存储、连不了网。
// 样本都在这里用字节拼出来（合成，不放真实文档）；中文 PDF 用夹具 fixtures/b4b1-zh-2p.pdf（2 页、内嵌黑体子集，PyMuPDF 生成，12 KB）。
// 另测 prep（预览材料，5.13 第 2 点 ④）：页数、纯文本、首页缩略图（PNG，长边 ≤ 384）；PDF 左侧页缩略图（线框 sPrev 电脑浮层）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';
import { utils, write } from 'xlsx';
import { expect, test } from './session-fixture.ts';

// 要登录态：没登录时 /app/ 会转到登录页，登录页的 CSP frame-src 只放 Turnstile，嵌不了沙箱
test.use({ trace: 'off', loggedIn: true });

const PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]>>endobj',
  '4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
].join('\n');

async function docx(): Promise<Buffer> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>재직증明 测试段落</w:t></w:r></w:p><w:p><w:hyperlink><w:r><w:t>链接文字</w:t></w:r></w:hyperlink></w:p></w:body></w:document>');
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function xlsx(): Buffer {
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet([['日期', '项目', '金额'], ['10/02', '<img src=x onerror=alert(1)>', 30000]]), '汇总');
  utils.book_append_sheet(wb, utils.aoa_to_sheet(Array.from({ length: 2100 }, (_, i) => [i])), '明细');
  return write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function pptx(): Promise<Buffer> {
  const z = new JSZip();
  const a = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  z.file('ppt/slides/slide1.xml', `<p:sld xmlns:p="x" ${a}><a:t>韩国生活分享</a:t><a:t>副标题</a:t></p:sld>`);
  z.file('ppt/slides/slide2.xml', `<p:sld xmlns:p="x" ${a}><a:t>外国人登录证怎么办</a:t></p:sld>`);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function bomb(): Promise<Buffer> {
  const z = new JSZip();
  z.file('word/a.bin', Buffer.alloc(60 * 1024 * 1024, 0x41));
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** 在 /app/ 页里嵌沙箱，等 ready，交字节进去，回第一条 state / error */
async function openIn(page: Page, way: string, bytes: Buffer): Promise<Record<string, unknown>> {
  await page.goto('/app/');
  await expect(page).not.toHaveURL(/\/app\/auth/);
  return page.evaluate(
    async ({ way, b64 }) => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.src = '/app/preview';
      // 压在 App 启动画面（z-index 2147483000）上面，截图才看得到沙箱
      f.style.cssText = 'position:fixed;inset:0;width:800px;height:600px;z-index:2147483647;background:#fff';
      f.dataset['testid'] = 'pv';
      const ready = new Promise<void>((res) => {
        const on = (e: MessageEvent): void => {
          if (e.source === f.contentWindow && (e.data as { t?: string }).t === 'ready') {
            window.removeEventListener('message', on);
            res();
          }
        };
        window.addEventListener('message', on);
      });
      document.body.append(f);
      await ready;
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
      const got = new Promise<Record<string, unknown>>((res) => {
        window.addEventListener('message', (e) => {
          const d = e.data as { t?: string };
          if (e.source === f.contentWindow && (d.t === 'state' || d.t === 'error')) res(d as Record<string, unknown>);
        });
      });
      f.contentWindow?.postMessage({ t: 'open', way, bytes: raw, lang: 'zh' }, '*', [raw]);
      return got;
    },
    { way, b64: bytes.toString('base64') },
  );
}

const frame = (page: Page) => page.frameLocator('iframe[data-testid="pv"]');

const ZH_PDF = readFileSync(join(import.meta.dirname, 'fixtures', 'b4b1-zh-2p.pdf'));

/** 在 /app/ 页里另起一个隐藏的沙箱（App 加附件时就这样用），发 prep，回结果；缩略图在页面里解开，只回 PNG 签名和宽高 */
async function prepIn(page: Page, way: string, bytes: Buffer): Promise<Record<string, unknown>> {
  await page.goto('/app/');
  await expect(page).not.toHaveURL(/\/app\/auth/);
  return page.evaluate(
    async ({ way, b64 }) => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.src = '/app/preview';
      f.hidden = true;
      const ready = new Promise<void>((res) => {
        window.addEventListener('message', (e) => {
          if (e.source === f.contentWindow && (e.data as { t?: string }).t === 'ready') res();
        });
      });
      document.body.append(f);
      await ready;
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
      const got = new Promise<Record<string, unknown>>((res) => {
        window.addEventListener('message', (e) => {
          const d = e.data as { t?: string; id?: string };
          if (e.source === f.contentWindow && d.t === 'prep' && d.id === 'req-1') res(d as Record<string, unknown>);
        });
      });
      f.contentWindow?.postMessage({ t: 'prep', id: 'req-1', way, bytes: raw }, '*', [raw]);
      const m = await got;
      const thumb = m['thumb'];
      if (!(thumb instanceof ArrayBuffer)) return m;
      const sig = [...new Uint8Array(thumb, 0, 8)].join(',');
      const bmp = await createImageBitmap(new Blob([thumb], { type: 'image/png' }));
      return { ...m, thumb: { png: sig === '137,80,78,71,13,10,26,10', w: bmp.width, h: bmp.height } };
    },
    { way, b64: bytes.toString('base64') },
  );
}

test.describe('B4b-1 预览沙箱', () => {
  test('PDF：两页，画到 canvas', async ({ page }) => {
    const s = await openIn(page, 'pdf', Buffer.from(PDF, 'latin1'));
    expect(s).toMatchObject({ t: 'state', pages: 2, page: 1, zoom: 100 });
    await expect(frame(page).locator('canvas').first()).toBeVisible();
  });

  test('PDF：中文内嵌字体画出来；沙箱宽 ≥ 720 时左边页缩略图，点第 2 张跳到第 2 页', async ({ page }, info) => {
    const s = await openIn(page, 'pdf', ZH_PDF);
    expect(s).toMatchObject({ t: 'state', pages: 2, page: 1 });
    const f = frame(page);
    await expect(f.locator('.pv-pages .pv-page[data-n="1"] canvas')).toBeVisible();
    // 读第一页 canvas 的像素：有深色点（文字、横线），不是一张白纸
    const fr = page.frames().find((x) => x.url().includes('/app/preview'));
    if (!fr) throw new Error('找不到沙箱 frame');
    const dark = await fr.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('.pv-pages .pv-page[data-n="1"] canvas');
      const d = c?.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      if (d) for (let i = 0; i < d.length; i += 4) if ((d[i] ?? 255) < 100 && (d[i + 1] ?? 255) < 100 && (d[i + 2] ?? 255) < 100) n++;
      return n;
    });
    expect(dark).toBeGreaterThan(500);

    const tn = f.locator('.pv-rail .pv-tn');
    await expect(tn).toHaveCount(2);
    await expect(tn.first()).toBeVisible();
    await expect(tn.first()).toHaveAttribute('aria-current', 'page');
    await expect(tn.nth(1).locator('canvas')).toBeVisible();   // 缩略图进入视野就画
    if (info.project.name === 'chromium') await page.locator('iframe[data-testid="pv"]').screenshot({ path: info.outputPath('sandbox-pdf-zh.png') });
    await tn.nth(1).click();
    await expect(tn.nth(1)).toHaveAttribute('aria-current', 'page');
    await expect(tn.first()).not.toHaveAttribute('aria-current', 'page');
    const top = await fr.evaluate(() => document.querySelector('.pv-pages .pv-page[data-n="2"]')?.getBoundingClientRect().top ?? -1);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(40);
  });

  test('PDF：沙箱窄于 720（手机）不显示页缩略图', async ({ page }) => {
    await openIn(page, 'pdf', ZH_PDF);
    await page.locator('iframe[data-testid="pv"]').evaluate((el: HTMLElement) => { el.style.width = '390px'; });
    await expect(frame(page).locator('.pv-rail')).toBeHidden();
    await expect(frame(page).locator('.pv-pages .pv-page[data-n="1"]')).toBeVisible();
  });

  test('prep PDF：页数、中文纯文本、第一页 PNG 缩略图长边 ≤ 384', async ({ page }) => {
    const m = await prepIn(page, 'pdf', ZH_PDF);
    expect(m).toMatchObject({ t: 'prep', id: 'req-1', pages: 2, thumb: { png: true } });
    expect(m['text']).toContain('出入境申请表');
    expect(m['text']).toContain('全租和月租的区别');
    const t = m['thumb'] as { w: number; h: number };
    expect(Math.max(t.w, t.h)).toBeLessThanOrEqual(384);
    expect(Math.max(t.w, t.h)).toBeGreaterThan(300);
  });

  test('prep Word、Excel、PPT：页数和纯文本；没有缩略图给 null', async ({ page }) => {
    expect(await prepIn(page, 'docx', await docx())).toMatchObject({ t: 'prep', pages: null, thumb: null, text: expect.stringContaining('测试段落') });
    const x = await prepIn(page, 'xlsx', xlsx());
    expect(x).toMatchObject({ t: 'prep', pages: 2, thumb: null });
    expect(x['text']).toContain('汇总');
    expect(x['text']).toContain('<img src=x onerror=alert(1)>');
    expect(await prepIn(page, 'pptx', await pptx())).toMatchObject({ t: 'prep', pages: 2, thumb: null, text: expect.stringContaining('外国人登录证怎么办') });
  });

  test('prep：ZIP 炸弹回 bad_archive，坏 PDF 回 render', async ({ page }) => {
    expect(await prepIn(page, 'docx', await bomb())).toEqual({ t: 'prep', id: 'req-1', error: 'bad_archive' });
    expect(await prepIn(page, 'pdf', Buffer.from('not a pdf'))).toEqual({ t: 'prep', id: 'req-1', error: 'render' });
  });

  test('Word：渲染正文，外链去掉，没有脚本', async ({ page }) => {
    const s = await openIn(page, 'docx', await docx());
    expect(s).toMatchObject({ t: 'state' });
    await expect(frame(page).getByText('测试段落')).toBeVisible();
    // 只查渲染出来的正文（沙箱页自己有入口 <script>）
    expect(await frame(page).locator('.pv-docx').locator('script, [onerror], a[href^="http"]').count()).toBe(0);
  });

  test('Excel：两张表，超过 2000 行标 clipped；单元格内容按文字显示', async ({ page }) => {
    const s = await openIn(page, 'xlsx', xlsx());
    expect(s).toMatchObject({ t: 'state', sheets: ['汇总', '明细'], sheet: 0, clipped: false });
    await expect(frame(page).getByText('<img src=x onerror=alert(1)>')).toBeVisible();
    expect(await frame(page).locator('img').count()).toBe(0);
  });

  test('PPT 退路：每页文字', async ({ page }) => {
    const s = await openIn(page, 'pptx', await pptx());
    expect(s).toMatchObject({ t: 'state', pages: 2 });
    await expect(frame(page).getByText('外国人登录证怎么办')).toBeVisible();
  });

  test('ZIP 炸弹：按真实解压字节数拒（压缩包异常）', async ({ page }) => {
    expect(await openIn(page, 'docx', await bomb())).toEqual({ t: 'error', why: 'bad_archive' });
  });

  test('沙箱没有来源：读不到 App 的 localStorage、连不了网', async ({ page, csp }) => {
    csp.expectViolations(); // 本用例故意 fetch，CSP 的 connect-src 'none' 必须拦下（下面逐条核对拦的是这一项）
    await openIn(page, 'pptx', await pptx());
    const f = page.frames().find((x) => x.url().includes('/app/preview'));
    expect(f).toBeTruthy();
    const r = await f!.evaluate(async () => {
      let storage = 'ok';
      try {
        void window.localStorage.length;
      } catch {
        storage = 'blocked';
      }
      let net = 'ok';
      try {
        await fetch('/app/version.json');
      } catch {
        net = 'blocked';
      }
      return { origin: window.origin, storage, net };
    });
    expect(r).toEqual({ origin: 'null', storage: 'blocked', net: 'blocked' });
    expect(csp.consoleErrors.length).toBeGreaterThan(0);
    for (const m of csp.consoleErrors) expect(m).toContain('/app/version.json');
  });
});
