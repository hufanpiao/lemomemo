// 提交前密钥检查（.githooks/pre-commit）没启用时给提示（B0 QA D-09、B1 接手清单 C12）。
// 用法：npm run check:hooks；npm run deps:rebuild（装完依赖必跑的那一步）也会顺带调它。
// .npmrc 设了 ignore-scripts=true，prepare、postinstall 不会跑，所以挂在 deps:rebuild 上。
// 只提示、不让任何步骤失败（不改退出码）；CI 里不需要本机钩子，直接跳过。
// 启用：npm run hooks:install（等于 git config core.hooksPath .githooks），每台开发电脑做一次。
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function warnIfHooksOff() {
  if (process.env.CI) return true;
  let hooksPath = '';
  try {
    hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // 没有这一项时 git config --get 退出码是 1；不在 git 仓库里或没装 git 也走这里，按“没启用”处理
  }
  const ok = hooksPath.replace(/\\/g, '/').replace(/\/+$/, '').endsWith('.githooks');
  if (!ok) {
    console.warn('');
    console.warn('【提示】git 提交前密钥检查没启用（core.hooksPath ' + (hooksPath ? '是 ' + hooksPath : '为空') + '）。');
    console.warn('        这台电脑上提交不会先用 gitleaks 扫暂存区，TC-B0-58“本机提交被拦”不成立。');
    console.warn('        在仓库根目录执行一次：npm run hooks:install（或 git config core.hooksPath .githooks）');
    console.warn('        核对：git config --get core.hooksPath 应输出 .githooks');
    console.warn('');
  }
  return ok;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) warnIfHooksOff();
