// D1（build/check_data_manifest.ts、build/ci/d1_negative.mjs）连哪个库（11-05 主持人定，安全红线）：
// 原来没设 D1_DB_URL 就默认连 127.0.0.1:54322——本机那是 supabase_db_lemomemo（11-05 后端误连过一次）。现在：
//   ① 设了 D1_DB_URL：必须是本机地址（127.0.0.1、localhost、[::1]）、端口 55322（lemo-e2e）、不带查询参数和 #，CI 里也一样
//      （复审 L1、L2；ci.yml 的 d1_negative 那一步因此不设 D1_DB_URL，走 ② 的默认）；
//   ② 没设 D1_DB_URL：只有 CI 放行，用 supabase start 的 54322（lemo-ci）。CI 环境变量本机 act 也会设，所以还要过 store-it 护栏的
//      config 检查（projectIdProblem：顶层恰好一行 project_id = "lemo-ci"，ci.yml 在 supabase start 之前用 sed 改成这样）和 .env* 检查；
//      仓库原样的 config 是 lemomemo，本机设了 CI 也拒绝。
// 纯函数，Node 和 Deno 都能用；读仓库文件由调用方给（readRepoState）。
import { projectIdProblem, readRepoState } from '../../supabase/tests/store-it/guard.mjs';

export const CI_DEFAULT_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const E2E_PORT = '55322';
const HINT = '本机请先 npm run e2e:real:up，再把 D1_DB_URL 设成 lemo-e2e 的库（127.0.0.1:55322）跑（跑完 npm run e2e:real:down）';

/**
 * 返回 { url } 或 { problem }（理由里不带口令）。
 * @param {{ CI?: string | undefined, D1_DB_URL?: string | undefined }} env
 * @param {() => { configText: string, dirListing: Record<string, string[]> }} readRepo 只在没设 D1_DB_URL 时调
 */
export function d1Target(env, readRepo) {
  const set = env.D1_DB_URL;
  if (set !== undefined && set !== '') {
    // 设了就一律只许 lemo-e2e：本机、55322、不带查询参数和 #，CI=true 也不例外（复审 L1；CI 不设 D1_DB_URL，走下面的默认）
    let u;
    try { u = new URL(set); } catch { return { problem: `D1_DB_URL 不是合法地址。${HINT}` }; }
    // 复审 L2：postgres.js 认 ?host=、?port= 这类查询参数，地址里看到的主机端口不一定是实际连的
    if (/[?#]/.test(set) || u.search !== '' || u.hash !== '') return { problem: `D1_DB_URL 不许带查询参数或 #，拒绝。${HINT}` };
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return { problem: `D1_DB_URL 不是本机地址（${u.hostname}），拒绝` };
    if (u.port !== E2E_PORT) return { problem: `D1_DB_URL 只许 lemo-e2e 的 ${E2E_PORT} 端口（现在是 ${u.port || '默认'}；54322 是 lemomemo），CI 里也不许设成别的端口。${HINT}` };
    return { url: set };
  }
  if (env.CI !== 'true') return { problem: `没设 D1_DB_URL：本机不许用默认的 54322（那是 lemomemo）。${HINT}` };
  let repo;
  try { repo = readRepo(); } catch (e) { return { problem: `没设 D1_DB_URL、读不到仓库的 supabase 配置（${e instanceof Error ? e.message : String(e)}），拒绝` }; }
  for (const [dir, names] of Object.entries(repo.dirListing)) {
    const bad = names.filter((n) => /^\.env/i.test(n));
    if (bad.length > 0) return { problem: `没设 D1_DB_URL：${dir} 里有 ${bad.join('、')}，拒绝用默认的 54322` };
  }
  const p = projectIdProblem(repo.configText);
  if (p !== null) return { problem: `没设 D1_DB_URL：${p}，拒绝用默认的 54322。${HINT}` };
  return { url: CI_DEFAULT_URL };
}

/** 调用方用：仓库根目录 → 读仓库现状的函数 */
export const repoReader = (root) => () => readRepoState(root);
