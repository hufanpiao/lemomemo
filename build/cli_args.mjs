// 构建后几项检查（check_size、check_first_paint_chunks、check_glass_css、check_splash_css、check_no_probe）和 build_web.mjs 共用的命令行参数解析
//（11-14 构建与架构检查整块评审：原来每个 cli() 各写一份 indexOf，参数缺值时悄悄回落到默认值，--x=v 有的认有的不认，路径有的按仓库根、有的按当前目录）。
// 约定：
//   - 认 --x v 和 --x=v 两种写法；写了 --x 却没给值（后面没有、后面是另一个 --开头的参数、--x= 后面空着）抛 UsageError；
//   - 路径参数一律按仓库根 ROOT 解析（绝对路径原样），在哪个目录下跑结果都一样；
//   - withUsage 包住 cli()：UsageError 打印说明、返回退出码 2（和 check_arch.py 的 argparse 一样），别的错照常抛。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 命令行参数写错（缺值） */
export class UsageError extends Error {}

/** --name 的值；没写这个参数返回 undefined，写了没给值抛 UsageError */
export function argValue(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) {
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('--')) throw new UsageError(`参数 ${name} 后面缺值`);
      return v;
    }
    if (a?.startsWith(`${name}=`)) {
      const v = a.slice(name.length + 1);
      if (v === '') throw new UsageError(`参数 ${name}= 后面缺值`);
      return v;
    }
  }
  return undefined;
}

/** 路径参数：按 ROOT 解析；没写时用 fallback（也按 ROOT 解析） */
export const argPath = (argv, name, fallback) => resolve(ROOT, argValue(argv, name) ?? fallback);

/** 包一层 cli(argv)：UsageError → 打印、返回 2 */
export function withUsage(cli) {
  return (argv) => {
    try {
      return cli(argv);
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      console.error(e.message);
      return 2;
    }
  };
}
