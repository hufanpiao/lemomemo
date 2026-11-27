// “被移除”的原始原因 → 能记进日志的两项
// • 设置页、导出的请求被拒成 revoked 时，失败结果的 why 带着原始错误；记日志的地方（设置页 hooks/useSettingsPage.ts，懒加载）先过 lossWhy 再记。
//   单独成文件：error-kind.ts 在首屏，首屏余量很紧。告知页（接口在首屏）这一路没带
// • code 只收短码：先认 message 里的 session_revoked、unauthorized（PostgREST 把 raise 变成 P0001 + message），再认形如 xxx_yyy 的 code；
//   其余记 '-'，服务器原文一律不带出来。status 没有记 0。只记日志、lemo.authloss 的 status，不参与“被移除”的判断
// 纯 TS
import { errParts } from './error-kind.ts';

export interface LossWhy {
  code: string;
  status: number;
}

const WHY_CODE = /^[A-Za-z0-9_]{1,40}$/;
const WHY_MSG = /\b(session_revoked|unauthorized)\b/;

export function lossWhy(e: unknown): LossWhy {
  const p = errParts(e);
  if (!p) return { code: '-', status: 0 };
  const code = WHY_MSG.exec(p.msg)?.[1] ?? (WHY_CODE.test(p.code) ? p.code : '-');
  return { code, status: p.status >= 0 ? p.status : 0 };
}
