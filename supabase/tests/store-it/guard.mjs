// 打仓库根目录那套本地 Supabase 的放行判断（11-05 主持人定，安全红线）：仓库 supabase/config.toml 的 project_id 是 lemomemo（本机在用的库），
// 本机绝不能把集成测试、pgTAP 写进去。只有 CI 放行，而且一律白名单、对不上就拒绝（11-05 审查 M2、M3）：
//   ① CI 环境变量正好是 'true'。只看它不够：act 在本机跑工作流也会设 CI（安全复审二 R1-1），所以下面几条都要过；
//   ② 环境变量里没有任何 SUPABASE_*（不分大小写）：CLI 2.120 认 SUPABASE_PROJECT_ID、SUPABASE_API_PORT、SUPABASE_WORKDIR 等，能绕过 config
//      （tools/e2e/real-backend.mjs 文件头）；ci.yml 的 db 任务不设这些变量；
//   ③ 仓库根目录、supabase/ 下没有 .env* 文件（CLI 会读 cwd 的 .env、.env.local、.env.<SUPABASE_ENV>）；
//   ④ config.toml：第一个 [小节] 之前只许空行、注释和恰好一行 project_id = "lemo-ci"（ci.yml 在 supabase start 之前用 sed 改成这样）；
//      全文别处凡是含 project 的行（[remotes.x] 里的 project_id、引号键、缩进、单引号等）、任何 \u / \U 转义（引号键能拼出 project_id）、
//      任何 [remotes 小节，一律拒绝。
// 这里只放判断（纯函数，可测）；命令行入口在 guard-cli.mjs（不做“是不是被直接运行”的判断，被调就查：审查 M1，经目录联接调用时入口判断会失败放行）。
// 本机改用 lemo-e2e：node supabase/tests/store-it/run.mjs --e2e-sb；pgTAP 用 supabase test db --db-url 指 lemo-e2e 的 55322。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCAL_HINT = '本机不许打仓库根目录的 Supabase（project_id 是 lemomemo）。本机请先 npm run e2e:real:up，再跑 node supabase/tests/store-it/run.mjs --e2e-sb；跑完 npm run e2e:real:down';
const WANT = 'project_id = "lemo-ci"';

/** config.toml 的项目名写法不合格就回理由；合格回 null */
export function projectIdProblem(configText) {
  const lines = configText.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim().startsWith('['));
  const top = first === -1 ? lines : lines.slice(0, first);
  let hits = 0;
  for (const l of top) {
    const t = l.trim();
    if (t === '' || t.startsWith('#')) continue;
    if (l === WANT) { hits++; continue; }
    return `supabase/config.toml 第一个小节之前有别的写法（${t.slice(0, 40)}），只许恰好一行 ${WANT}`;
  }
  if (hits !== 1) return `supabase/config.toml 第一个小节之前要恰好一行 ${WANT}（现在 ${hits} 行）`;
  const rest = first === -1 ? [] : lines.slice(first);
  for (const l of rest) {
    if (/project/i.test(l)) return `supabase/config.toml 小节里出现含 project 的行（${l.trim().slice(0, 40)}），拒绝`;
    if (/^\s*\[\s*remotes/i.test(l)) return 'supabase/config.toml 有 [remotes] 小节，拒绝';
  }
  if (/\\u/i.test(configText)) return 'supabase/config.toml 里有 \\u 转义（引号键能拼出 project_id），拒绝';
  return null;
}

/**
 * 返回拒绝理由；放行返回 null。
 * @param {Record<string, string | undefined>} env
 * @param {string} configText supabase/config.toml 全文
 * @param {Record<string, string[]>} dirListing 目录 → 文件名（仓库根目录、supabase/）
 */
export function repoSupabaseProblem(env, configText, dirListing) {
  if (env.CI !== 'true') return `没在 CI 里（CI 环境变量不是 true）。${LOCAL_HINT}`;
  const sb = Object.keys(env).filter((k) => /^supabase_/i.test(k));
  if (sb.length > 0) return `环境变量里有 ${sb.join('、')}：supabase CLI 会用它绕过 config，拒绝。${LOCAL_HINT}`;
  for (const [dir, names] of Object.entries(dirListing)) {
    const bad = names.filter((n) => /^\.env/i.test(n));
    if (bad.length > 0) return `${dir} 里有 ${bad.join('、')}：supabase CLI 会读它覆盖 config，拒绝。${LOCAL_HINT}`;
  }
  const p = projectIdProblem(configText);
  return p === null ? null : `${p}。${LOCAL_HINT}`;
}

/** 读仓库现状给 repoSupabaseProblem：config 全文和两层目录清单（读不到一律当拒绝处理，由调用方兜） */
export function readRepoState(root) {
  return {
    configText: readFileSync(join(root, 'supabase', 'config.toml'), 'utf8'),
    dirListing: { './': readdirSync(root), 'supabase/': readdirSync(join(root, 'supabase')) },
  };
}

/** run.mjs、guard-cli.mjs 共用：读不到文件也算拒绝 */
export function checkRepoSupabase(root, env) {
  try {
    const { configText, dirListing } = readRepoState(root);
    return repoSupabaseProblem(env, configText, dirListing);
  } catch (e) {
    return `读不到仓库的 supabase 配置（${e instanceof Error ? e.message : String(e)}），拒绝。${LOCAL_HINT}`;
  }
}
