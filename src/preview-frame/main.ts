// 【占位】预览沙箱（架构 5.13 第 3 点，Vite 的第三个入口 /app/preview.html）
// B4b-1 在这里接 pdf.js、docx-preview、SheetJS；它有自己的 CSP（_headers 里单独一段），不给 allow-same-origin
// B0 只确认入口能单独打包、CSP 段落能单独生效
const root = document.getElementById('preview');
if (root) root.dataset['ready'] = '1';
