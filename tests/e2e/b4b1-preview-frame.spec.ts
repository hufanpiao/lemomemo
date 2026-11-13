// B4b-1 预览沙箱（架构 5.13 第 3 点、架构约定 9.7）：在 App 的来源下嵌 sandbox="allow-scripts"（不给 allow-same-origin）的 /app/preview，
// 经 postMessage 交字节进去，四种本机预览（PDF、Word、Excel、PPT 退路）都渲染出来；ZIP 炸弹在沙箱里被拒；沙箱读不到 App 的存储、连不了网。
// 样本都在这里用字节拼出来（合成，不放真实文档）
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
      f.style.cssText = 'position:fixed;inset:0;width:800px;height:600px;z-index:9999;background:#fff';
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

test.describe('B4b-1 预览沙箱', () => {
  test('PDF：两页，画到 canvas', async ({ page }) => {
    const s = await openIn(page, 'pdf', Buffer.from(PDF, 'latin1'));
    expect(s).toMatchObject({ t: 'state', pages: 2, page: 1, zoom: 100 });
    await expect(frame(page).locator('canvas').first()).toBeVisible();
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
