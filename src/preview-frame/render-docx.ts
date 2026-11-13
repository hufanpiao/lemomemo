// Word（.docx）预览（架构 5.13 第 3 点：docx-preview → DOMPurify）。
// • docx-preview 先渲染进一个不挂在页面上的容器（图片转成 data: 地址，useBase64URL），再整段过 DOMPurify：去掉脚本、事件属性、
//   外链（href 一律去掉，只留页内 #锚点）、iframe、object、form；docx-preview 生成的 <style> 留着（沙箱 CSP 只在这里放 'unsafe-inline'）
// • 按页往下排（线框 dn：Word 按页往下排）；缩放用 CSS zoom
import DOMPurify from 'dompurify';
import { renderAsync } from 'docx-preview';
import type { Post, View } from './main.ts';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const href = node.getAttribute('href');
  if (href !== null && !href.startsWith('#')) node.removeAttribute('href');
  node.removeAttribute('target');
});

export async function render(root: HTMLElement, bytes: ArrayBuffer, post: Post): Promise<View> {
  const scratch = document.createElement('div');
  const styles = document.createElement('div');
  await renderAsync(bytes, scratch, styles, {
    inWrapper: true, ignoreLastRenderedPageBreak: true, useBase64URL: true, renderComments: false, renderChanges: false,
    experimental: false, trimXmlDeclaration: true, debug: false,
  });
  const clean = DOMPurify.sanitize(styles.innerHTML + scratch.innerHTML, {
    ADD_TAGS: ['style'], FORCE_BODY: true, FORBID_TAGS: ['form', 'input', 'button', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
    ALLOWED_URI_REGEXP: /^(?:data:image\/(?:png|jpeg|gif|webp|bmp);|#)/i, RETURN_DOM_FRAGMENT: true,
  });
  const box = document.createElement('div');
  box.className = 'pv-docx';
  box.append(clean);
  root.append(box);
  const pages = Math.max(1, box.querySelectorAll('section.docx').length);
  let zoom = 100;
  const state = (): void => post({ t: 'state', page: 1, pages, zoom, sheets: [], sheet: 0, clipped: false });
  state();
  return {
    page(n) {
      box.querySelectorAll('section.docx')[n - 1]?.scrollIntoView({ block: 'start' });
    },
    zoom(z) {
      zoom = z;
      box.style.zoom = String(z / 100);
      state();
    },
    sheet() {},
  };
}
