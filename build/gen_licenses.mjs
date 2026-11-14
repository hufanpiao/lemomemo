// 构建时生成第三方开源许可清单 /app/licenses.txt（R-410，11-13 负责人定：只生成文件，界面不加入口）
// • 范围：package-lock.json 里不是 dev 的包（生产依赖连同它们的依赖），去掉只有类型声明的 @types/*；多算几个只会多列，不会漏
// • 每个包：名字、版本、许可证（lock 里的 license 字段），再原样附上包目录下的许可文件（LICENSE、LICENCE、COPYING、NOTICE、
//   CopyrightNotice 开头的文件，按文件名排序）；包里一个都没有的写明只有许可证名
// • 编进二进制里的第三方代码另列（EMBEDDED）：@jsquash/webp 的 wasm 里编的是 libwebp（Google，BSD-3，分发二进制必须带版权声明），
//   原文在它包里的 codec/LICENSE.codec.md。原来手工拷的 src/public/licenses/webp-wasm.txt 并进这里，不再单独维护一份
// • 可选字体（架构 5.9c，B6 字体 11-14）：按 assets-src/fonts/<id>/font.json 的 licenses 逐项列字体名、版本、许可证、来源和许可证原文
//   （OFL 1.1 第 2 条：分发字体要带版权声明和许可证；字体分片的名字表也留着版权、许可证两项）。登记是唯一来源，不另抄一份
// • 输出只取决于 lock 和 node_modules：按包名排序、换行统一成 \n；同样的依赖构建两次一字不差
// • 不进 SW 预缓存（inject_sw_manifest.mjs 的 excluded、src/sw/routes.ts 的 excludedFromPrecache），只在联网时打开
// 用法：node build/gen_licenses.mjs --app-dir dist/web/app（build_web.mjs 在 vite build 之后调 writeLicenses）
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_NAME = 'licenses.txt';
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyrightnotice)([.\-_].*)?$/i;
const RULE = '='.repeat(78);

/** 编在别的包的二进制里的第三方代码：包名、包内许可文件、标题 */
export const EMBEDDED = [{ pkg: '@jsquash/webp', file: 'codec/LICENSE.codec.md', title: 'libwebp（编在 @jsquash/webp 的 wasm 编码器里，Copyright (c) 2010, Google Inc.）— BSD-3-Clause' }];

const norm = (s) => s.replace(/\r\n?/g, '\n').trimEnd();

/** 字体登记里的许可证：[{ id, label, name, version, spdx, sourceUrl, text }]，按字体 id、登记里的先后 */
export function fontLicenses(root = ROOT) {
  const base = join(root, 'assets-src', 'fonts');
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .sort()
    .filter((id) => existsSync(join(base, id, 'font.json')))
    .flatMap((id) => {
      const r = JSON.parse(readFileSync(join(base, id, 'font.json'), 'utf8'));
      return (r.licenses ?? []).map((l) => ({ id, label: r.label?.zh ?? id, name: l.name, version: l.version, spdx: l.spdx, sourceUrl: l.sourceUrl, text: norm(readFileSync(join(base, id, l.file), 'utf8')) }));
    });
}

/** lock 里要列的包：[{ name, version, license, dir }]，按名字、再按目录排序 */
export function shippedPackages(root = ROOT) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  return Object.entries(lock.packages ?? {})
    .filter(([key, v]) => key !== '' && !v.dev && !v.link)
    .map(([key, v]) => ({ name: key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length), version: v.version ?? '?', license: v.license ?? '未写明', dir: join(root, key) }))
    .filter((p) => !p.name.startsWith('@types/'))
    .sort((a, b) => (a.name === b.name ? (a.dir < b.dir ? -1 : 1) : a.name < b.name ? -1 : 1));
}

function section(title, body) {
  return `${RULE}\n${title}\n${RULE}\n\n${body}\n`;
}

function licenseFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => norm(readFileSync(join(dir, f), 'utf8')));
}

/** 整份清单的文本 */
export function licensesText(root = ROOT) {
  const pkgs = shippedPackages(root);
  const fonts = fontLicenses(root);
  const parts = [
    '柠檬记随产物分发的第三方开源组件许可',
    '由 build/gen_licenses.mjs 在构建时按 package-lock.json 的生产依赖和 assets-src/fonts 的字体登记生成，不要手改。',
    `共 ${pkgs.length} 个包，另有 ${EMBEDDED.length} 项编在二进制里的第三方代码（列在最前）、${fonts.length} 项可选字体（列在其后）。`,
    '',
  ];
  for (const e of EMBEDDED) {
    const p = pkgs.find((x) => x.name === e.pkg);
    const dir = p?.dir ?? join(root, 'node_modules', e.pkg);
    parts.push(section(`${e.title}（随 ${e.pkg} ${p?.version ?? '?'} 分发）`, norm(readFileSync(join(dir, e.file), 'utf8'))));
  }
  for (const f of fonts) parts.push(section(`字体：${f.name} ${f.version} — ${f.spdx}（设置 › 字体“${f.label}”，/app/fonts/${f.id}/；来源 ${f.sourceUrl}）`, f.text));
  for (const p of pkgs) {
    const files = licenseFiles(p.dir);
    parts.push(section(`${p.name} ${p.version} — ${p.license}`, files.length ? files.join('\n\n') : `（包里没有许可文件；package.json 写的许可证：${p.license}）`));
  }
  return `${parts.join('\n').trimEnd()}\n`;
}

/** 写进 appDir/licenses.txt，返回字节数 */
export function writeLicenses(appDir, root = ROOT) {
  const text = licensesText(root);
  writeFileSync(join(appDir, OUT_NAME), text);
  return Buffer.byteLength(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--app-dir');
  if (i < 0 || !process.argv[i + 1]) {
    console.error('用法：node build/gen_licenses.mjs --app-dir <dist/web/app>');
    process.exit(2);
  }
  console.log(`已生成 ${OUT_NAME}：${writeLicenses(resolve(process.argv[i + 1]))} 字节`);
}
