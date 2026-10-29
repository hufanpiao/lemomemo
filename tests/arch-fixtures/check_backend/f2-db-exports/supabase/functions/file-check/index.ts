import { withScan } from '../_shared/db.ts';
// 违规 F2（复审必改，r6：模板字符串拼出 fn_vault）
const v = 'vault';
export const x = withScan(`fn_${v}`, async () => 1);
