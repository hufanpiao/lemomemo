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
  // account：导出、注销、恢复、查状态（status）。0.38 第 47 条：旧版本也必须能导出、注销（以及冷静期里恢复）；转发层不读请求体，分不出是哪个动作，所以整个 POST 免查。
  // 以后 account 新加会写同步表的动作：要么挪到别的函数，要么在 account 里自己查版本（这一项免掉的是整个 POST）。
  { name: 'account', methods: ['POST'], caller: 'client', why: 'export-delete-restore-status-on-old-clients' },
  // pg_cron 经 pg_net 调，带 x-cron-secret，没有客户端版本；免查只免版本，鉴权照旧由 x-cron-secret 管
  { name: 'account-purge', methods: ['POST'], caller: 'server', why: 'cron-x-cron-secret' },
  // B2：push-dispatch 同样是 pg_cron 每分钟调、带 x-cron-secret（B2 安全审查 D1-S6）
  { name: 'push-dispatch', methods: ['POST'], caller: 'server', why: 'cron-x-cron-secret' },
  // B4：ai-classify 每 2 分钟由 pg_cron 调、带 x-cron-secret（架构 5.2）
  { name: 'ai-classify', methods: ['POST'], caller: 'server', why: 'cron-x-cron-secret' },
  // B3（BE-5）：claude-intake 由 tools/claude-intake/add.ps1 经 /sb 调，带连接码、不带 JWT，也不是 App，没有客户端版本；
  // 只收 POST（其余方法 405），鉴权由连接码的 SHA-256 查 api_tokens 管（check_backend F9 ⑥）
  { name: 'claude-intake', methods: ['POST'], caller: 'client', why: 'connection-code-add-ps1' },
  // lemo-ops 调，带 x-ops-secret，没有客户端版本；鉴权照旧由 x-ops-secret 管
  { name: 'usage-report', methods: ['POST'], caller: 'server', why: 'ops-x-ops-secret' },
  // B5（任务单 S18、0.29 续第 77 条）：vault-image 只读、写隐私记插图的字节，旧版也要能看隐私记的图；鉴权照旧由 JWT + x-vault-token 管。
  // vault 本身不进（0.29 续第 75 条），旧版走不到解锁这一步，也就拿不到令牌
  { name: 'vault-image', methods: ['POST'], caller: 'client', why: 'vault-images-on-old-clients' },
];

/** fn 的 method 请求免不免查（OPTIONS 不在这里判断，由调用方先放行） */
export function isFunctionExempt(list: readonly FunctionExemption[], fn: string, method: string): boolean {
  const m = method.toUpperCase();
  const ex = list.find((f) => f.name === fn);
  return ex !== undefined && (ex.methods.includes('*') || ex.methods.includes(m));
}
