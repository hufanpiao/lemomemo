// 安装脚本白名单（架构 8.3：npm ci --ignore-scripts，再只给白名单里的包跑安装脚本）
// 白名单在 package.json 的 lemo.allowScripts；B0 实测为空：esbuild、workerd 的 postinstall 只是校验和兜底下载，
// 平台二进制由 optionalDependencies（@esbuild/win32-x64、@cloudflare/workerd-windows-64 等）直接装好，不跑也能用
// 用法：npm ci --ignore-scripts && node build/rebuild_allowed.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const allow = pkg.lemo?.allowScripts ?? [];

if (allow.length === 0) {
  console.log('rebuild_allowed：白名单为空，没有要跑安装脚本的包');
  process.exit(0);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const r = spawnSync(npm, ['rebuild', '--ignore-scripts=false', ...allow], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
