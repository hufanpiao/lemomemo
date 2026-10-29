// 对照：能用 R2 的函数经别名引 aws4fetch 不报；版本号写法的依赖（zod）不报
import { AwsV4Signer } from 'signer';
import { z } from 'zod';
export const s = [AwsV4Signer, z];
