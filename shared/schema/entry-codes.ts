// 各 Edge Function 入口共用的错误码（接手清单 ENTRY-codes，10-31 代码审查建议）：前端三处共用；后端各函数回的是这些字面量，未引用此表。
// • 不属于哪个函数自己的码表，所以不放进 ACCOUNT_ERROR_CODES（见 account.ts 文件头）、也不放进邀请注册的码表；
//   各函数的入口（鉴权、版本门、读请求体、读环境变量）都可能回这几个
// • 不引 zod：登录页（features/auth）也用它，登录页的严格 CSP 下 zod 4 的 allowsEval 探测会报 eval 违规
// • 前端三处各按自己的错误类型落地，映射表在各自文件里（键必须覆盖这里的全部码，类型管着）：
//   features/auth/data/auth-api.ts 的 INVITE_ENTRY、features/auth/data/account-gate.ts 的 RESTORE_ENTRY、
//   features/settings/data/account-api.ts 的 ACCOUNT_ENTRY。三处的一致性由 tests/shared/entry-codes.test.ts 锁住
export const ENTRY_ERROR_CODES = [
  'bad_request',          // 400  请求体读不出、字段不对（前端的 bug）
  'method_not_allowed',   // 405  不是 POST（前端的 bug）
  'unauthorized',         // 401  没带令牌、令牌无效
  'session_revoked',      // 401  会话已被吊销
  'upgrade_required',     // 426  版本门：客户端太旧（platform/http 统一处理，各处按 HTTP 状态走）
  'misconfigured',        // 500  函数缺环境变量等配置错误：显示“出错”，不当稍后再试
] as const;

export type EntryErrorCode = (typeof ENTRY_ERROR_CODES)[number];

/** 每个码的含义类别。目前只给测试和文档用（tests/shared/entry-codes.test.ts），src 里不按类别判断，各处按自己的映射表落地 */
export type EntryCodeKind = 'client_bug' | 'session_lost' | 'version_gate' | 'server_config';

/** 码 → 类别（同上：只给测试和文档用，src 里不按类别判断） */
export const ENTRY_CODE_KIND = {
  bad_request: 'client_bug',
  method_not_allowed: 'client_bug',
  unauthorized: 'session_lost',
  session_revoked: 'session_lost',
  upgrade_required: 'version_gate',
  misconfigured: 'server_config',
} as const satisfies Record<EntryErrorCode, EntryCodeKind>;

/** 是不是入口共用码（只认自己的键，不会取到 Object.prototype 上的东西） */
export function isEntryErrorCode(v: unknown): v is EntryErrorCode {
  return typeof v === 'string' && ENTRY_ERROR_CODES.some((c) => c === v);
}
