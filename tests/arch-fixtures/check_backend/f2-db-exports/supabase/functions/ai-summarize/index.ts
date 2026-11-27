import { withScan } from '../_shared/db.ts';
// 违规 F2（复审必改，r4：计算属性名 + Object.keys 取出 fn_vault）
const t = { ['fn_' + 'vault']: 1 } as const;
export const x = withScan(Object.keys(t)[0] ?? '', async () => 1);
