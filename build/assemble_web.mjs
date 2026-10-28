// 拼出 dist/web（架构 8.1、16.2）：
// - site/ 原样复制到 dist/web/ 根目录（官网，前端 B；还没有时跳过）
// - _headers = site/_headers（首页那段，前端 B）+ src/_headers（/app/* 那段，前端 A），{{WSS}} 按模式替换
// - _routes.json（前端 B）有就复制
// - dist/web/app/version.json
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WSS = {
  production: 'wss://lemomemo.com',
  preview: 'wss://preview.lemomemo.com',
  e2e: 'ws://127.0.0.1:8788',
  development: 'ws://127.0.0.1:8788',
  test: 'ws://127.0.0.1:8788',
};

export function renderHeaders(appHeaders, siteHeaders, mode) {
  const wss = WSS[mode];
  if (!wss) throw new Error(`未知的构建模式：${mode}`);
  const app = appHeaders.replaceAll('{{WSS}}', wss);
  if (app.includes('{{')) throw new Error('_headers 里还有没替换的占位符');
  return siteHeaders ? `${siteHeaders.trimEnd()}\n\n${app}` : app;
}

export async function assembleWeb({ root, mode }) {
  const web = resolve(root, 'dist/web');
  const site = resolve(root, 'site');
  if (existsSync(site)) cpSync(site, web, { recursive: true, filter: (p) => !p.endsWith('_headers') });
  const siteHeadersPath = resolve(site, '_headers');
  const siteHeaders = existsSync(siteHeadersPath) ? readFileSync(siteHeadersPath, 'utf8') : '';
  const appHeaders = readFileSync(resolve(root, 'src/_headers'), 'utf8');
  writeFileSync(resolve(web, '_headers'), renderHeaders(appHeaders, siteHeaders, mode));
  const routes = resolve(root, '_routes.json');
  if (existsSync(routes)) cpSync(routes, resolve(web, '_routes.json'));
  const version = readFileSync(resolve(root, 'VERSION'), 'utf8').trim();
  writeFileSync(resolve(web, 'app/version.json'), `${JSON.stringify({ version })}\n`);
}
