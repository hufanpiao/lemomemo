// 违规 F7（第五轮必改 1）：引别的函数目录里的文件（借 invite-signup 的 secret 读 SIGNUP_HASH_SECRET）
import { readSecret } from '../invite-signup/secret.ts';
export const d6 = readSecret();
