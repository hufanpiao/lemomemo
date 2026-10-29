// 版本门的免查函数名单：唯一出处（架构 0.27 第 1 点、第 6 节、14.2 第 10 点；0.31 第 13 条；0.38 第 47 条）。
// 两道检查都读这一份：
//   • 转发层 functions/sb/version-gate.ts 的 EXEMPT_FUNCTIONS = 这里 caller 为 'client' 的几项（浏览器和 exe 经 /sb 调的）；
//   • 函数侧 supabase/functions/_shared/version-gate.ts（经 build/copy_shared.mjs 复制到 _shared/gen/）= 这里全部几项。
// caller 为 'server' 的（pg_cron 经 pg_net、lemo-ops 调的，带 x-cron-secret / x-ops-secret）没有客户端版本，函数里免查；
// 但它们一律直连 <ref>.supabase.co、不经 /sb（0.31 第 13 条），所以转发层不放行——从 /sb 进来的照样查版本。
// 名单外的函数一律查。CI：build/check_version_gate.mjs 核对名单里的函数目录都存在；
// tests/functions/fn-version-gate.test.ts 核对 supabase/functions/ 下每个函数都标了“查”或“免”，两道检查的结论一致。

export interface FunctionExemption {
  /** supabase/functions/<name> */
  name: string;
  /** 大写方法名；'*' 表示任何方法。只免列出的方法，其余方法照查 */
  methods: readonly string[];
  /** client：浏览器和 exe 经 /sb 调；server：服务器之间直连调用，转发层不放行 */
  caller: 'client' | 'server';
  /** 英文短标识（A20：shared 的字符串里不写汉字），中文说明写在每一项上方的注释里 */
  why: string;
}

export const FUNCTION_VERSION_EXEMPTIONS: readonly FunctionExemption[] = [
  // account：导出、注销、恢复。0.38 第 47 条：旧版本也必须能导出、注销（以及冷静期里恢复）；转发层不读请求体，分不出是哪个动作，所以整个 POST 免查。
  // 以后 account 新加会写同步表的动作：要么挪到别的函数，要么在 account 里自己查版本（这一项免掉的是整个 POST）。
  { name: 'account', methods: ['POST'], caller: 'client', why: 'export-delete-restore-on-old-clients' },
  // pg_cron 经 pg_net 调，带 x-cron-secret，没有客户端版本；免查只免版本，鉴权照旧由 x-cron-secret 管
  { name: 'account-purge', methods: ['POST'], caller: 'server', why: 'cron-x-cron-secret' },
  // lemo-ops 调，带 x-ops-secret，没有客户端版本；鉴权照旧由 x-ops-secret 管
  { name: 'usage-report', methods: ['POST'], caller: 'server', why: 'ops-x-ops-secret' },
];

/** fn 的 method 请求免不免查（OPTIONS 不在这里判断，由调用方先放行） */
export function isFunctionExempt(list: readonly FunctionExemption[], fn: string, method: string): boolean {
  const m = method.toUpperCase();
  const ex = list.find((f) => f.name === fn);
  return ex !== undefined && (ex.methods.includes('*') || ex.methods.includes(m));
}
