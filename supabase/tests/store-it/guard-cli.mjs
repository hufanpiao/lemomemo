// npm run test:db 的第一步（11-05 审查 M1）：被调就查，不判断“是不是被直接运行”（那种判断经目录联接、subst 盘、符号链接调用时会对不上，
// 对不上就什么都不查、退出码 0，下一步 supabase test db 打进 lemomemo）。规则在 guard.mjs。放行退出码 0，拒绝退出码 2。
// 仓库根目录按本文件的位置算（import.meta.dirname 是真实路径），不看 cwd。
import { resolve } from 'node:path';
import { checkRepoSupabase } from './guard.mjs';

const p = checkRepoSupabase(resolve(import.meta.dirname, '..', '..', '..'), process.env);
if (p !== null) {
  console.error(`test:db：${p}`);
  process.exitCode = 2;
}
