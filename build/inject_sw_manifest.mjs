// 把预缓存清单注入 sw.js（做法同 Workbox injectManifest：替换 self.__WB_MANIFEST）（架构 8.1）
// 不用 workbox-build（依赖很多），自己算：带哈希的文件 revision 为 null，其余按内容的 sha256 前 16 位
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const HASHED = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2|png|svg|webp)$/;

/** 和 src/sw/routes.ts 的 excludedFromPrecache 保持一致（tests/build/inject-sw.test.ts 比对） */
export function excluded(path) {
  return (
    path === 'sw.js' ||
    path.startsWith('holidays/') ||
    path.startsWith('fonts/') ||
    path.startsWith('icons/startup/') ||
    path.startsWith('.vite/') ||
    path.endsWith('.map') ||
    path === 'version.json'
  );
}

function walk(dir, base, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split('\\').join('/'));
  }
  return out;
}

export function buildManifest(appDir) {
  return walk(appDir, appDir, [])
    .filter((p) => !excluded(p))
    .sort()
    .map((p) => ({
      url: `/app/${p}`,
      revision: HASHED.test(p) ? null : createHash('sha256').update(readFileSync(join(appDir, p))).digest('hex').slice(0, 16),
    }));
}

export async function injectSwManifest(appDir) {
  const swPath = join(appDir, 'sw.js');
  const sw = readFileSync(swPath, 'utf8');
  const marker = 'self.__WB_MANIFEST';
  const count = sw.split(marker).length - 1;
  if (count !== 1) throw new Error(`sw.js 里应当正好有一处 ${marker}，实际 ${count} 处`);
  const manifest = buildManifest(appDir);
  writeFileSync(swPath, sw.replace(marker, JSON.stringify(manifest)));
  return manifest.length;
}
