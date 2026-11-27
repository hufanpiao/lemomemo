// 违规 F2（S3 第三轮复审建议）：相对路径写成大写 ../_shared/DB.ts，Windows 上照样载入 db.ts；Linux CI 上也要认出来
import { withAiUser } from '../_shared/DB.ts';
export const x = withAiUser;
